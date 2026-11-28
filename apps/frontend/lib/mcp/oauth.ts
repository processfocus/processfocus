import "server-only"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { DateTime, Result, Schema } from "effect"
import { type NextRequest, NextResponse } from "next/server"
import { type ProviderUserSession, subjects } from "@pf/auth-session"
import { type Tokens, createClient } from "@pf/openauth/client"
import { OAuthMetadataFetchError } from "@pf/openauth/error"
import {
  connectedAppsPath,
  consentPath,
  cookieName,
  loopback,
  mcpOrigin,
  opaque,
} from "./origin"
import { bucket } from "./store"
import { getAuthClient } from "@/lib/auth/client"
import { getFrontendAuthClientConfig } from "@/lib/auth/issuer"
import { decodeJwtPayload } from "@/lib/auth/jwt"
import { acceptVerifiedSession } from "@/lib/auth/ssr-session"
import { getFrontendManifest } from "@/lib/frontend-manifest-store"

const VIEW = "work:read"
const ACT = "work:act"
const pendingLifetime = 600_000
const codeLifetime = 60_000
const registrationLifetime = 3_600_000
// Outlast the serving Lambda's 20-second timeout but release after a cold exit.
const renewalLease = 30_000
const headers = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'none'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
}
const random = () => randomBytes(32).toString("base64url")
const hash = (text: string) =>
  createHash("sha256").update(text).digest("base64url")
const Grant = Schema.Struct({
  id: Schema.String,
  clientId: Schema.String,
  userId: Schema.String,
  scope: Schema.Literals([VIEW, `${VIEW} ${ACT}`]),
  authorisedAt: Schema.Int,
})
type Grant = typeof Grant.Type
const Client = Schema.Struct({
  name: Schema.String,
  redirects: Schema.Array(Schema.String),
  grants: Schema.Array(Grant),
})
const authFields = {
  clientId: Schema.String,
  redirect: Schema.String,
  challenge: Schema.String,
  state: Schema.String,
}
const Human = Schema.Struct({
  email: Schema.String,
  userId: Schema.String,
  tokens: Schema.Struct({
    access: Schema.String,
    refresh: Schema.String,
    expiresIn: Schema.Number,
    refreshExpiresIn: Schema.optional(Schema.Number),
  }),
  expires: Schema.Number,
  ssoDeadline: Schema.optional(Schema.Number),
})
type Human = typeof Human.Type
const Pending = Schema.Struct({
  ...authFields,
  browser: Schema.String,
  expires: Schema.Number,
  grantsAtStart: Schema.Array(Grant),
  human: Schema.optional(Human),
})
const Code = Schema.Struct({ ...authFields, grant: Grant, human: Human })
type Code = typeof Code.Type
const Access = Schema.Struct({ grant: Grant, token: Schema.String })
const Renewal = Schema.Struct({
  grant: Grant,
  expires: Schema.Number,
  ssoDeadline: Schema.optional(Schema.Number),
  issuerRefreshToken: Schema.String,
  lockedUntil: Schema.Number,
})

const clients = (origin: string) => bucket(origin, "client", Client)
const pending = (origin: string) => bucket(origin, "pending", Pending)
const codes = (origin: string) => bucket(origin, "code", Code)
const access = (origin: string) => bucket(origin, "access", Access)
const refresh = (origin: string) => bucket(origin, "refresh", Renewal)

const registeredClient = (origin: string, clientId: string) =>
  opaque.test(clientId) ? clients(origin).get(clientId) : undefined

const activeGrant = async (origin: string, grant: Grant) =>
  (await registeredClient(origin, grant.clientId))?.value.grants.some(
    (current) => current.id === grant.id,
  )

const location = (url: URL, status = 303) =>
  new NextResponse(null, {
    status,
    headers: { ...headers, Location: url.href },
  })
const oauthError = (error: string, status = 400) =>
  Response.json({ error }, { status, headers })

const resourceUrl = (origin: string) => `${origin}/mcp`
const issuerUrl = (origin: string) =>
  process.env["PF_RUNTIME_MODE"] === "deployed" ? resourceUrl(origin) : origin
export const resourceMetadata = (origin: string): Response =>
  Response.json(
    {
      resource: resourceUrl(origin),
      authorization_servers: [issuerUrl(origin)],
      scopes_supported: [VIEW, ACT],
      bearer_methods_supported: ["header"],
    },
    { headers },
  )

export const authMetadata = (origin: string): Response =>
  Response.json(
    {
      issuer: issuerUrl(origin),
      authorization_endpoint: `${origin}/mcp/authorize`,
      token_endpoint: `${origin}/mcp/token`,
      registration_endpoint: `${origin}/mcp/register`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [VIEW, ACT],
    },
    { headers },
  )

const Registration = Schema.Struct({
  client_name: Schema.NonEmptyString.check(Schema.isMaxLength(100)),
  redirect_uris: Schema.NonEmptyArray(
    Schema.String.check(Schema.isMaxLength(2048)),
  ).check(Schema.isMaxLength(5)),
  token_endpoint_auth_method: Schema.optional(Schema.Literal("none")),
})
const validRedirect = (uri: string) => {
  try {
    const url = new URL(uri)
    return (
      !uri.includes("#") &&
      ((loopback(url) && Boolean(url.port)) ||
        (process.env["PF_RUNTIME_MODE"] === "deployed" &&
          url.protocol === "https:" &&
          !url.username &&
          !url.password))
    )
  } catch {
    return false
  }
}

export const register = async (
  request: Request,
  origin: string,
): Promise<Response> => {
  const body = await request.json().catch(() => null)
  const parsed = Schema.decodeUnknownResult(Registration)(body)
  if (Result.isFailure(parsed)) return oauthError("invalid_client_metadata")
  const { client_name, redirect_uris } = parsed.success
  if (!redirect_uris.every(validRedirect))
    return oauthError("invalid_redirect_uri")
  const store = clients(origin)
  if (process.env["PF_RUNTIME_MODE"] !== "deployed") {
    let count = 0
    for await (const _ of store.entries()) {
      if (++count >= 1024) return oauthError("temporarily_unavailable", 503)
    }
  }
  const id = random()
  const saved = await store.put(
    id,
    {
      name: client_name,
      redirects: redirect_uris,
      grants: [],
    },
    Date.now() + registrationLifetime,
  )
  if (!saved) return oauthError("temporarily_unavailable", 503)
  return Response.json(
    {
      client_id: id,
      client_name,
      redirect_uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    { status: 201, headers },
  )
}

const readAuthorization = (origin: string, query: URLSearchParams) => {
  const clientId = query.get("client_id") ?? ""
  const redirect = query.get("redirect_uri") ?? ""
  const challenge = query.get("code_challenge") ?? ""
  const state = query.get("state") ?? ""
  const resource = query.get("resource")
  if (
    query.get("response_type") !== "code" ||
    query.get("code_challenge_method") !== "S256" ||
    !opaque.test(challenge) ||
    state.length > 512 ||
    (resource !== null && resource !== resourceUrl(origin))
  )
    return undefined
  return { clientId, redirect, challenge, state }
}

const consentUrl = (origin: string, id: string) =>
  new URL(`${consentPath}?id=${id}`, origin)
const cookieOptions = (origin: string) =>
  ({
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: origin.startsWith("https:"),
  }) as const

export const authorize = async (
  request: NextRequest,
  origin: string,
): Promise<Response> => {
  const authorization = readAuthorization(origin, request.nextUrl.searchParams)
  if (!authorization) return oauthError("invalid_request")
  const client = await registeredClient(origin, authorization.clientId)
  if (!client?.value.redirects.includes(authorization.redirect))
    return oauthError("invalid_request")
  const store = pending(origin)
  if (process.env["PF_RUNTIME_MODE"] !== "deployed") {
    let count = 0
    for await (const _ of store.entries()) {
      if (++count >= 256) return oauthError("temporarily_unavailable", 503)
    }
  }
  const id = random()
  const browser = random()
  const expires = Date.now() + pendingLifetime
  const saved = await store.put(
    id,
    {
      ...authorization,
      // Resolve the grant after sign-in, but do not revive one disconnected
      // while this authorization was in flight.
      grantsAtStart: client.value.grants,
      browser,
      expires,
    },
    expires,
  )
  if (!saved) return oauthError("temporarily_unavailable", 503)
  const consent = consentUrl(origin, id)
  const login = new URL("/login", origin)
  login.searchParams.set("redirect", `${consent.pathname}${consent.search}`)
  const response = location(login)
  response.cookies.set(cookieName(origin, id), browser, {
    ...cookieOptions(origin),
    maxAge: pendingLifetime / 1000,
  })
  return response
}

const browserPending = async (request: NextRequest, target: string | null) => {
  const origin = mcpOrigin(request)
  if (!origin || !target?.startsWith(`${consentPath}?`)) return undefined
  const id = new URL(target, origin).searchParams.get("id") ?? ""
  if (!opaque.test(id)) return undefined
  const browser = request.cookies.get(cookieName(origin, id))?.value
  if (!browser) return undefined
  const record = await pending(origin).get(id)
  if (!record || browser !== record.value.browser) return undefined
  return { record, origin, id }
}

const verifyHuman = async (
  tokens: Tokens,
): Promise<{ human: Human; session: ProviderUserSession } | undefined> => {
  const verified = await getAuthClient().verify(
    subjects,
    tokens.access,
    undefined,
  )
  if (verified.err instanceof OAuthMetadataFetchError) throw verified.err
  if (verified.err) return undefined
  const session = verified.subject.properties
  if (!("email" in session) || !session.humanSession || session.delegation)
    return undefined
  const expiry = decodeJwtPayload(tokens.access)?.exp
  const ssoDeadline = session.sso?.expiresAt
  const expires = Math.min((expiry ?? 0) * 1000, ssoDeadline ?? Infinity)
  if (expires <= Date.now()) return undefined
  return {
    session,
    human: {
      email: session.email,
      userId: session.userId,
      tokens,
      expires,
      ssoDeadline,
    },
  }
}

export const finishMcpLogin = async (
  request: NextRequest,
  redirect: string | null,
  tokens: Tokens,
): Promise<NextResponse | undefined> => {
  if (!redirect?.startsWith(`${consentPath}?`)) return undefined
  const flow = await browserPending(request, redirect)
  if (!flow || flow.record.value.human)
    return NextResponse.json(
      { error: "Restart the MCP connection." },
      { status: 400, headers },
    )
  const verified = await verifyHuman(tokens).catch(() => undefined)
  if (
    !verified ||
    !(await acceptVerifiedSession(verified.session, tokens.access).catch(
      () => null,
    ))
  )
    return NextResponse.json(
      { error: "MCP requires a human sign-in." },
      { status: 403, headers },
    )
  const entry = flow.record.value
  if (
    entry.expires <= Date.now() ||
    !(await pending(flow.origin).put(
      flow.id,
      { ...entry, human: verified.human },
      entry.expires,
      flow.record,
    ))
  )
    return NextResponse.json(
      { error: "Restart the MCP connection." },
      { status: 400, headers },
    )
  return location(consentUrl(flow.origin, flow.id))
}

const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

const finishAuthorization = async (
  {
    record: { value: entry },
    origin,
    id,
  }: NonNullable<Awaited<ReturnType<typeof browserPending>>>,
  approved?: Pick<Code, "grant" | "human">,
): Promise<Response> => {
  const redirect = new URL(entry.redirect)
  if (entry.state) redirect.searchParams.set("state", entry.state)
  if (approved) {
    const code = random()
    const saved = await codes(origin).put(
      hash(code),
      {
        clientId: entry.clientId,
        challenge: entry.challenge,
        redirect: entry.redirect,
        state: entry.state,
        ...approved,
      },
      Date.now() + codeLifetime,
    )
    if (!saved) return oauthError("temporarily_unavailable", 503)
    redirect.searchParams.set("code", code)
  } else {
    redirect.searchParams.set("error", "access_denied")
  }
  const response = location(redirect)
  response.cookies.set(cookieName(origin, id), "", {
    ...cookieOptions(origin),
    maxAge: 0,
  })
  return response
}

const sameOriginForm = (request: Request, origin: string) =>
  request.headers.get("origin") === origin &&
  request.headers.get("content-type")?.split(";")[0] ===
    "application/x-www-form-urlencoded"

export const listConnections = async (origin: string, userId: string) => {
  const connections = []
  for await (const { value } of clients(origin).entries()) {
    const grant = value.grants.find((grant) => grant.userId === userId)
    if (grant) {
      connections.push({
        id: grant.id,
        clientId: grant.clientId,
        name: value.name,
        access: grant.scope === VIEW ? "View work" : "View and act",
        authorisedAt: grant.authorisedAt,
      })
    }
  }
  return connections
}

export const disconnectConnection = async ({
  origin,
  userId,
  clientId,
  grantId,
}: {
  origin: string
  userId: string
  clientId: string
  grantId: string
}): Promise<boolean> => {
  const client = await registeredClient(origin, clientId)
  if (
    !client?.value.grants.some(
      (grant) => grant.userId === userId && grant.id === grantId,
    )
  )
    return false
  const grants = client.value.grants.filter((grant) => grant.id !== grantId)
  // Codes and tokens check the current grant ID, not just the registration.
  // Revoking it invalidates every credential without touching Dashboard cookies.
  return Boolean(
    await clients(origin).put(
      clientId,
      { ...client.value, grants },
      grants.length === 0 ? Date.now() + registrationLifetime : undefined,
      client,
    ),
  )
}

const consentStyles = `
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: clamp(0.75rem, 4vw, 3rem);
    background: #f8fafc;
    color: #0f172a;
    font: 1rem/1.5 system-ui, sans-serif;
  }
  main {
    max-width: 36rem;
    margin-inline: auto;
    padding: clamp(1rem, 5vw, 2rem);
    border: 1px solid #e2e8f0;
    border-radius: 1.5rem;
    background: #fff;
    box-shadow: 0 1px 3px #0f172a14;
    overflow-wrap: anywhere;
  }
  .brand { display: flex; align-items: center; gap: 0.625rem; font-weight: 700; }
  .mark {
    display: grid;
    place-items: center;
    inline-size: 2.25rem;
    block-size: 2.25rem;
    border-radius: 0.625rem;
    background: #065f46;
    color: #fff;
    font-size: 0.875rem;
  }
  .eyebrow {
    margin: 1.5rem 0 0.25rem;
    color: #065f46;
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  h1 { margin: 0; font-size: clamp(1.5rem, 5vw, 2rem); line-height: 1.2; }
  .details {
    margin: 1.25rem 0;
    padding: 0.875rem 1rem;
    border-radius: 0.875rem;
    background: #f1f5f9;
  }
  .details p { margin: 0; }
  .details p + p { margin-block-start: 0.375rem; }
  .notice, .description { color: #475569; font-size: 0.9375rem; }
  fieldset { min-inline-size: 0; margin: 1.25rem 0 0; padding: 0; border: 0; }
  legend { padding: 0; font-weight: 700; }
  .option {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: start;
    gap: 0.75rem;
    margin-block-start: 0.5rem;
    padding: 0.75rem;
    border: 1px solid #cbd5e1;
    border-radius: 0.875rem;
    cursor: pointer;
  }
  .option:has(input:checked) { border-color: #047857; background: #ecfdf5; }
  input[type="radio"] { margin: 0.2rem 0 0; inline-size: 1.125rem; block-size: 1.125rem; }
  .description { display: block; }
  .actions { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-block-start: 1.5rem; }
  button {
    min-block-size: 3rem;
    padding: 0.625rem 1.25rem;
    border: 1px solid #64748b;
    border-radius: 999px;
    background: #fff;
    color: #0f172a;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  button:hover { background: #f1f5f9; }
  .primary { border-color: #065f46; background: #065f46; color: #fff; }
  .primary:hover { background: #064e3b; }
  .manage { margin: 1.25rem 0 0; }
  a { color: #065f46; text-underline-offset: 0.15em; }
  :focus-visible { outline: 3px solid #0f766e; outline-offset: 3px; }
`
const consentStyleHash = createHash("sha256")
  .update(consentStyles)
  .digest("base64")

export const consent = async (request: NextRequest): Promise<Response> => {
  const flow = await browserPending(
    request,
    `${request.nextUrl.pathname}${request.nextUrl.search}`,
  )
  const human = flow?.record.value.human
  if (!flow || !human) return oauthError("invalid_request")
  const { record, origin, id } = flow
  const entry = record.value
  const client = await registeredClient(origin, entry.clientId)
  if (!client) return oauthError("invalid_client")
  const existing = entry.grantsAtStart.find(
    (grant) => grant.userId === human.userId,
  )
  if (
    client.value.grants.find((grant) => grant.userId === human.userId)?.id !==
      existing?.id ||
    human.expires <= Date.now()
  )
    return oauthError("invalid_request")
  if (request.method === "GET") {
    const clientName = escapeHtml(client.value.name)
    const { organisation } = getFrontendManifest()
    const organisationName = escapeHtml(
      organisation.acronym ?? organisation.name,
    )
    const accessDetails = existing
      ? `<p>Existing access: ${existing.scope === VIEW ? "View work" : "View and act"}.</p>
         <p class="notice">Reconnecting only restores access. It does not run an interrupted action.</p>`
      : `<fieldset>
           <legend>Choose access</legend>
           <label class="option">
             <input type="radio" name="access" value="read" aria-labelledby="read-title" aria-describedby="read-description" checked>
             <span><strong id="read-title">View work</strong>
               <span class="description" id="read-description">Read-only access to work and forms.</span>
             </span>
           </label>
           <label class="option">
             <input type="radio" name="access" value="act" aria-labelledby="act-title" aria-describedby="act-description">
             <span><strong id="act-title">View and act</strong>
               <span class="description" id="act-description">View work, start Processes, complete To-Dos, and create, edit, or delete List records where your runtime permissions allow.</span>
             </span>
           </label>
         </fieldset>`
    const approve = existing
      ? `<button class="primary" type="submit" name="action" value="reconnect">Reconnect</button>`
      : `<button class="primary" type="submit">Allow access</button>`
    return new Response(
      `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${existing ? "Reconnect" : "Connect"} to Process Focus</title>
  <style>${consentStyles}</style>
</head>
<body>
  <main>
    <header>
      <div class="brand"><span class="mark" aria-hidden="true">PF</span> Process Focus</div>
      <p class="eyebrow">MCP connection</p>
      <h1>${existing ? "Reconnect" : "Connect"} ${clientName} to ${organisationName}?</h1>
    </header>
    <div class="details">
      <p><strong>Environment:</strong> ${escapeHtml(origin)}</p>
      <p><strong>Signed in as</strong> ${escapeHtml(human.email)}</p>
    </div>
    <p class="notice">Only approve a connection you just started in this client.</p>
    <form method="post" action="${consentPath}?id=${id}">
      ${accessDetails}
      <div class="actions">
        ${approve}
        <button type="submit" name="action" value="deny">Deny</button>
      </div>
    </form>
    <p class="manage"><a href="${connectedAppsPath}">Manage MCP connections</a></p>
  </main>
</body>
</html>`,
      {
        headers: {
          ...headers,
          // Keep Origin on the same-origin POST without disclosing the consent URL to the client.
          "Referrer-Policy": "same-origin",
          // Browsers can apply form-action to the OAuth redirect after POST.
          "Content-Security-Policy": `default-src 'none'; frame-ancestors 'none'; form-action 'self' ${new URL(entry.redirect).origin}; base-uri 'none'; style-src 'sha256-${consentStyleHash}'`,
          "Content-Type": "text/html; charset=utf-8",
        },
      },
    )
  }
  if (!sameOriginForm(request, origin))
    return oauthError("invalid_request", 403)
  const form = await request.formData().catch(() => null)
  if (!form || entry.expires <= Date.now() || human.expires <= Date.now())
    return oauthError("invalid_request")
  const denied = form.get("action") === "deny"
  const choice = form.get("access")
  if (
    !denied &&
    (existing
      ? form.get("action") !== "reconnect"
      : choice !== "read" && choice !== "act")
  )
    return oauthError("invalid_request")
  if (!(await pending(origin).remove(id, record)))
    return oauthError("invalid_request")
  if (denied) return finishAuthorization(flow)
  if (existing) {
    // Resume the existing scope; the OAuth flow never carries an MCP request.
    return (await activeGrant(origin, existing))
      ? finishAuthorization(flow, { grant: existing, human })
      : oauthError("invalid_request")
  }
  const grant: Grant = {
    id: random(),
    clientId: entry.clientId,
    userId: human.userId,
    scope: choice === "act" ? `${VIEW} ${ACT}` : VIEW,
    authorisedAt: DateTime.toEpochMillis(DateTime.nowUnsafe()),
  }
  if (
    !(await clients(origin).put(
      entry.clientId,
      {
        ...client.value,
        grants: [...client.value.grants, grant],
      },
      undefined,
      client,
    ))
  )
    return oauthError("invalid_request")
  return finishAuthorization(flow, { grant, human })
}

const issueTokens = async (
  origin: string,
  grant: Grant,
  human: Human,
): Promise<Response> => {
  if (!(await activeGrant(origin, grant))) return oauthError("invalid_grant")
  const token = random()
  const renewal = random()
  const now = Date.now()
  const expiresIn = Math.min(300, Math.floor((human.expires - now) / 1000))
  if (expiresIn <= 0) return oauthError("invalid_grant")
  const refreshExpires = Math.min(
    now + (human.tokens.refreshExpiresIn ?? 86_400) * 1000,
    human.ssoDeadline ?? Infinity,
  )
  const savedAccess = await access(origin).put(
    hash(token),
    {
      grant,
      token: human.tokens.access,
    },
    now + expiresIn * 1000,
  )
  const savedRefresh = await refresh(origin).put(
    hash(renewal),
    {
      grant,
      expires: refreshExpires,
      ssoDeadline: human.ssoDeadline,
      issuerRefreshToken: human.tokens.refresh,
      lockedUntil: 0,
    },
    refreshExpires,
  )
  if (!savedAccess || !savedRefresh)
    return oauthError("temporarily_unavailable", 503)
  return Response.json(
    {
      access_token: token,
      refresh_token: renewal,
      expires_in: expiresIn,
      token_type: "Bearer",
      scope: grant.scope,
    },
    { headers },
  )
}

export const token = async (
  request: Request,
  origin: string,
): Promise<Response> => {
  if (
    request.headers.get("content-type")?.split(";")[0] !==
    "application/x-www-form-urlencoded"
  )
    return oauthError("invalid_request")
  const form = await request.formData().catch(() => null)
  if (!form) return oauthError("invalid_request")
  const clientId = form.get("client_id")
  if (
    typeof clientId !== "string" ||
    !(await registeredClient(origin, clientId))
  )
    return oauthError("invalid_client")
  const resource = form.get("resource")
  if (resource !== null && resource !== resourceUrl(origin))
    return oauthError("invalid_target")
  if (form.get("grant_type") === "authorization_code") {
    const raw = form.get("code")
    const verifier = form.get("code_verifier")
    if (
      typeof raw !== "string" ||
      !opaque.test(raw) ||
      typeof verifier !== "string" ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)
    )
      return oauthError("invalid_grant")
    const id = hash(raw)
    const store = codes(origin)
    const record = await store.get(id)
    const code = record?.value
    if (
      !record ||
      !code ||
      code.clientId !== clientId ||
      code.redirect !== form.get("redirect_uri") ||
      !timingSafeEqual(
        Buffer.from(code.challenge),
        Buffer.from(hash(verifier)),
      ) ||
      !(await store.remove(id, record))
    )
      return oauthError("invalid_grant")
    return issueTokens(origin, code.grant, code.human)
  }
  if (form.get("grant_type") === "refresh_token") {
    const raw = form.get("refresh_token")
    if (typeof raw !== "string" || !opaque.test(raw))
      return oauthError("invalid_grant")
    const id = hash(raw)
    const store = refresh(origin)
    const original = await store.get(id)
    const entry = original?.value
    if (
      !original ||
      !entry ||
      entry.grant.clientId !== clientId ||
      !(await activeGrant(origin, entry.grant))
    )
      return oauthError("invalid_grant")
    const scope = form.get("scope")
    if (scope !== null && scope !== entry.grant.scope)
      return oauthError("invalid_scope")
    const now = Date.now()
    if (entry.lockedUntil > now)
      return oauthError("temporarily_unavailable", 503)
    let locked = await store.put(
      id,
      { ...entry, lockedUntil: now + renewalLease },
      entry.expires,
      original,
    )
    if (!locked) return oauthError("temporarily_unavailable", 503)
    try {
      const result = await createClient({
        ...getFrontendAuthClientConfig(),
        fetch: async (input, init) => {
          const response = await fetch(input, init)
          // OpenAuth maps other HTTP failures to InvalidRefreshTokenError.
          if (response.status === 429 || response.status >= 500)
            throw new Error("Issuer temporarily unavailable")
          return response
        },
      }).refresh(entry.issuerRefreshToken)
      if (result.err || !result.tokens) return oauthError("invalid_grant")
      // The issuer has rotated its token. Keep that rotation even if
      // signature verification cannot reach the issuer's metadata.
      const rotated = await store.put(
        id,
        {
          ...locked.value,
          issuerRefreshToken: result.tokens.refresh,
        },
        entry.expires,
        locked,
      )
      if (!rotated) return oauthError("invalid_grant")
      locked = rotated
      // The issuer renews the human session. GraphQL rechecks current
      // runtime authority on each tool call, not when rotating credentials.
      const verified = await verifyHuman(result.tokens)
      if (
        !verified ||
        verified.human.userId !== entry.grant.userId ||
        verified.human.ssoDeadline !== entry.ssoDeadline ||
        entry.expires <= Date.now()
      )
        return oauthError("invalid_grant")
      const response = await issueTokens(origin, entry.grant, verified.human)
      if (response.ok) {
        if (!(await store.remove(id, locked)))
          return oauthError("invalid_grant")
        locked = undefined
      }
      return response
    } catch {
      return oauthError("temporarily_unavailable", 503)
    } finally {
      if (locked)
        await store.put(
          id,
          { ...locked.value, lockedUntil: 0 },
          entry.expires,
          locked,
        )
    }
  }
  return oauthError("unsupported_grant_type")
}

export type McpAccess = {
  readonly accessToken: string
  readonly userId: string
  readonly canAct: boolean
}

export const readMcpAccess = async (
  request: Request,
  origin: string,
): Promise<McpAccess | undefined> => {
  const authorization = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(
    request.headers.get("authorization") ?? "",
  )
  const value = authorization?.[1]
  if (!value) return undefined
  const entry = (await access(origin).get(hash(value)))?.value
  if (
    !entry ||
    !(await activeGrant(origin, entry.grant)) ||
    !entry.grant.scope.split(" ").includes(VIEW)
  )
    return undefined
  return {
    accessToken: entry.token,
    userId: entry.grant.userId,
    canAct: entry.grant.scope.split(" ").includes(ACT),
  }
}

export const challenge = (origin: string): Response =>
  new Response(null, {
    status: 401,
    headers: {
      ...headers,
      "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
    },
  })
