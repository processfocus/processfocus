// Test-only upstream transport. Loaded ONLY into the disposable issuer process.
// Real GoogleProvider validation, PF codes, cookies and refresh are retained.
import { generateKeyPairSync, randomUUID, sign } from "node:crypto"

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
})
const invalidKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
}).privateKey
const jwk = publicKey.export({ format: "jwk" })
const codes = new Map()
const nativeServe = Bun.serve
const upstream = nativeServe({
  hostname: "127.0.0.1",
  port: Number(process.env.SSO_PROVIDER_PORT ?? 4599),
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/authorize") {
      const params =
        request.method === "POST"
          ? new URLSearchParams(await request.text())
          : url.searchParams
      const callback = new URL(params.get("redirect_uri"))
      if (
        callback.hostname !== "localhost" &&
        callback.hostname !== "127.0.0.1"
      )
        return new Response("Local callbacks only", { status: 400 })
      const silent = params.get("prompt") === "none"
      const silentResult = request.headers
        .get("cookie")
        ?.split("; ")
        .find((cookie) => cookie.startsWith("controlled_sso_revalidation="))
        ?.split("=")[1]
      const decision = silent
        ? (silentResult ?? "allow")
        : params.get("decision")
      if (!decision) {
        const hidden = [...params]
          .map(
            ([key, value]) =>
              `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`,
          )
          .join("")
        return new Response(
          `<h1>Controlled Google provider</h1><form method="post" action="/authorize">${hidden}
          <button type="submit" name="decision" value="allow">Continue as test user</button>
          <button type="submit" name="decision" value="other">Continue as other user</button>
          ${process.env.SSO_ADMIN_EMAIL ? '<button type="submit" name="decision" value="admin">Continue as administrator</button>' : ""}
          <button type="submit" name="decision" value="invalid-signature">Invalid signature</button>
          <button type="submit" name="decision" value="invalid-nonce">Invalid nonce</button>
          <button type="submit" name="decision" value="deny">Deny sign-in</button></form>`,
          { headers: { "content-type": "text/html" } },
        )
      }
      callback.searchParams.set("state", params.get("state"))
      if (silent && params.get("login_hint") !== "controlled-google-user") {
        callback.searchParams.set("error", "invalid_request")
      } else if (decision === "interaction") {
        callback.searchParams.set("error", "login_required")
      } else if (decision === "deny") {
        callback.searchParams.set("error", "access_denied")
      } else {
        const code = randomUUID()
        codes.set(code, {
          nonce: params.get("nonce"),
          audience: params.get("client_id"),
          decision,
        })
        callback.searchParams.set("code", code)
      }
      return Response.redirect(callback.toString(), 302)
    }
    return new Response("Not found", { status: 404 })
  },
})
function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}
const originalFetch = globalThis.fetch
globalThis.fetch = Object.assign(
  async (input, init) => {
    const request = new Request(input, init)
    if (request.url === "https://www.googleapis.com/oauth2/v3/certs")
      return Response.json({
        keys: [{ ...jwk, alg: "RS256", kid: "controlled-google", use: "sig" }],
      })
    if (request.url === "https://oauth2.googleapis.com/token") {
      const body = new URLSearchParams(await request.text())
      const code = body.get("code")
      const grant = codes.get(code)
      codes.delete(code)
      if (!grant)
        return Response.json({ error: "invalid_grant" }, { status: 400 })
      const now = Math.floor(Date.now() / 1000)
      const encode = (value) =>
        Buffer.from(JSON.stringify(value)).toString("base64url")
      const unsigned = `${encode({ alg: "RS256", kid: "controlled-google" })}.${encode(
        {
          iss: "https://accounts.google.com",
          aud: grant.audience,
          sub: `controlled-google-${grant.decision === "other" ? "other" : grant.decision === "admin" ? "admin" : "user"}`,
          email:
            grant.decision === "other"
              ? (process.env.SSO_OTHER_EMAIL ?? "settings-e2e@example.com")
              : grant.decision === "admin"
                ? process.env.SSO_ADMIN_EMAIL
                : (process.env.SSO_USER_EMAIL ?? "test@example.com"),
          email_verified: true,
          hd: "example.com",
          nonce:
            grant.decision === "invalid-nonce" ? "wrong-nonce" : grant.nonce,
          iat: now,
          exp: now + 300,
        },
      )}`
      return Response.json({
        access_token: "controlled-upstream-access",
        token_type: "Bearer",
        expires_in: 300,
        id_token: `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), grant.decision === "invalid-signature" ? invalidKey : privateKey).toString("base64url")}`,
      })
    }
    return originalFetch(input, init)
  },
  { preconnect: originalFetch.preconnect },
)

// Only redirect the browser's upstream hop; do not replace PF callback handling.
Bun.serve = (options) =>
  nativeServe({
    ...options,
    async fetch(request, server) {
      const response = await options.fetch(request, server)
      const location = response.headers.get("location")
      if (
        !location?.startsWith("https://accounts.google.com/o/oauth2/v2/auth?")
      )
        return response
      const target = new URL(location)
      target.protocol = "http:"
      target.host = `127.0.0.1:${upstream.port}`
      target.pathname = "/authorize"
      const headers = new Headers(response.headers)
      headers.set("location", target.toString())
      return new Response(response.body, { status: response.status, headers })
    },
  })
