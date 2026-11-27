import { createHash, createHmac, randomBytes } from "node:crypto"
import { Schema } from "effect"
import { NextRequest } from "next/server"
import { OAuthMetadataFetchError } from "@pf/openauth/error"
import { startMcpOAuthStorage } from "./fixtures/mcp-oauth-storage"
import { afterAll, beforeAll, expect, mock, spyOn, test } from "bun:test"

mock.module("server-only", () => ({}))
let metadataAvailable = true
mock.module("@/lib/auth/client", () => ({
  getAuthClient: () => ({
    verify: async () =>
      metadataAvailable
        ? {
            err: false,
            subject: {
              properties: {
                email: "alice@example.test",
                userId: "alice",
                humanSession: true,
              },
            },
          }
        : {
            err: new OAuthMetadataFetchError(
              "http://localhost:4020/.well-known/jwks.json",
              "Service unavailable",
            ),
          },
  }),
}))
mock.module("@/lib/auth/issuer", () => ({
  getFrontendAuthClientConfig: () => ({
    clientID: "frontend",
    issuer: "http://localhost:4020",
  }),
}))
let graphqlEndpoint: string
mock.module("@/lib/graphql/endpoint", () => ({
  getGraphqlEndpoint: () => graphqlEndpoint,
}))

const {
  authorize,
  consent,
  disconnectConnection,
  finishMcpLogin,
  listConnections,
  register,
  token,
} = await import("../lib/mcp/oauth")
const { bucket } = await import("../lib/mcp/store")
const secret = randomBytes(32).toString("hex")
const previousEnv = {
  INTERNAL_API_SECRET: process.env["INTERNAL_API_SECRET"],
  PF_MCP_STORAGE_SECRET: process.env["PF_MCP_STORAGE_SECRET"],
  PF_MCP_STORAGE_ORIGIN: process.env["PF_MCP_STORAGE_ORIGIN"],
  PUBLIC_TODO_TOKEN_SECRET: process.env["PUBLIC_TODO_TOKEN_SECRET"],
  PF_MCP_DOMAIN: process.env["PF_MCP_DOMAIN"],
}
let storage: Awaited<ReturnType<typeof startMcpOAuthStorage>>
beforeAll(async () => {
  storage = await startMcpOAuthStorage(secret)
  graphqlEndpoint = `${storage.origin}/graphql`
  // The callback and MCP servers use independent credentials.
  process.env["INTERNAL_API_SECRET"] = randomBytes(32).toString("hex")
  process.env["PF_MCP_STORAGE_SECRET"] = secret
  process.env["PF_MCP_STORAGE_ORIGIN"] = storage.origin
  process.env["PUBLIC_TODO_TOKEN_SECRET"] = secret
})
afterAll(async () => {
  await storage?.stop()
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test("the MCP storage route requires its own bearer and validates requests", async () => {
  const path = "/internal/mcp-oauth"
  const url = new URL(path, storage.origin)
  const callbackSecret = process.env["INTERNAL_API_SECRET"] ?? ""
  const bearer = (key: string) =>
    `Bearer ${createHmac("sha256", key).update(path).digest("base64url")}`
  const request = (
    authorization: string,
    method: string,
    body?: Record<string, string>,
  ) =>
    fetch(url, {
      method,
      headers: { authorization, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

  const unauthorized = await request(bearer(callbackSecret), "POST", {
    op: "list",
    partition: "http://localhost:3000#client",
  })
  expect(unauthorized.status).toBe(401)
  expect(await unauthorized.text()).toBe("")
  expect((await request(bearer(secret), "GET")).status).toBe(405)
  expect((await request(bearer(secret), "POST", { op: "list" })).status).toBe(
    400,
  )
})

test("only one writer can replace the same MCP record revision", async () => {
  const originalMode = process.env["PF_RUNTIME_MODE"]
  process.env["PF_RUNTIME_MODE"] = "local"
  try {
    const records = bucket("http://localhost:3003", "client", Schema.Unknown)
    const initial = await records.put("client", { winner: 0 })
    if (!initial) throw new Error("Expected to create the MCP record")
    const updates = await Promise.all([
      records.put("client", { winner: 1 }, undefined, initial),
      records.put("client", { winner: 2 }, undefined, initial),
    ])
    const successful = updates.filter((update) => update !== undefined)
    expect(successful).toHaveLength(1)
    expect(await records.get("client")).toEqual(successful[0])
  } finally {
    if (originalMode === undefined) delete process.env["PF_RUNTIME_MODE"]
    else process.env["PF_RUNTIME_MODE"] = originalMode
  }
})

async function expectFreshDashboardStatus(
  origin: string,
  accessToken: string,
  status: number,
) {
  const child = Bun.spawn(
    ["bun", "test", "./test/fixtures/mcp-access-probe.ts"],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, GRAPHQL_ENDPOINT: graphqlEndpoint },
      stdin: new Blob([JSON.stringify({ origin, accessToken, status })]),
      stderr: "pipe",
    },
  )
  const diagnostics = await child.stderr.text()
  expect(await child.exited, diagnostics).toBe(0)
}

async function verifyGrantLifecycle(mode: "local" | "deployed") {
  const origin =
    mode === "local" ? "http://localhost:3000" : "https://work.example.test"
  const host = new URL(origin).host
  const redirect = "http://127.0.0.1:3001/callback"
  const access = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 7200 })).toString("base64url")}.signature`
  const issuerTokens = {
    access,
    refresh: "issuer-refresh",
    expiresIn: 7200,
    refreshExpiresIn: 7200,
  }
  const env = process.env["PF_RUNTIME_MODE"]
  let graphqlAvailable = true
  const submittedIssuerTokens: string[] = []
  const fetch = globalThis.fetch
  const issuer = spyOn(globalThis, "fetch").mockImplementation(
    async (input, init) => {
      if (String(input).startsWith(`${storage.origin}/internal/`))
        return fetch(input, init)
      if (String(input) === graphqlEndpoint)
        return graphqlAvailable
          ? Response.json({ data: { __typename: "Query" } })
          : Response.json(
              { errors: [{ message: "Service unavailable" }] },
              { status: 503 },
            )
      if (
        String(input) !== "http://localhost:4020/oauth/token" ||
        typeof init?.body !== "string"
      )
        throw new Error("Unexpected upstream request")
      submittedIssuerTokens.push(
        new URLSearchParams(init.body).get("refresh_token") ?? "",
      )
      if (submittedIssuerTokens.length === 1)
        return Response.json({ error: "server_error" }, { status: 503 })
      return Response.json({
        access_token: access,
        refresh_token: "rotated-issuer-refresh",
        expires_in: 600,
      })
    },
  )
  process.env["PF_RUNTIME_MODE"] = mode
  process.env["PF_MCP_DOMAIN"] = host
  try {
    const registration = await register(
      new Request(`${origin}/mcp/register`, {
        method: "POST",
        body: JSON.stringify({
          client_name: "OpenCode",
          redirect_uris: [redirect],
        }),
      }),
      origin,
    )
    const { client_id } = await registration.json()
    const verifier = randomBytes(32).toString("base64url")
    const authQuery = new URLSearchParams({
      client_id,
      redirect_uri: redirect,
      response_type: "code",
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    })
    const auth = await authorize(
      new NextRequest(`${origin}/mcp/authorize?${authQuery}`),
      origin,
    )
    const browserCookie = auth.headers.get("set-cookie")?.split(";")[0]
    const returnTo = new URL(
      auth.headers.get("location") ?? "",
    ).searchParams.get("redirect")
    const signedIn = await finishMcpLogin(
      new NextRequest(`${origin}/api/auth/callback`, {
        headers: { host, cookie: browserCookie ?? "" },
      }),
      returnTo,
      issuerTokens,
    )
    const approved = await consent(
      new NextRequest(signedIn?.headers.get("location") ?? "", {
        method: "POST",
        headers: {
          host,
          origin,
          cookie: browserCookie ?? "",
        },
        body: new URLSearchParams({ access: "read" }),
      }),
    )
    const code =
      new URL(approved.headers.get("location") ?? "").searchParams.get(
        "code",
      ) ?? ""
    const requestToken = (fields: Record<string, string>) =>
      token(
        new Request(`${origin}/mcp/token`, {
          method: "POST",
          body: new URLSearchParams({ client_id, ...fields }),
        }),
        origin,
      )
    const exchange = {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirect,
    }
    const exchanges = await Promise.all([
      requestToken(exchange),
      requestToken(exchange),
    ])
    expect(exchanges.map(({ status }) => status).sort()).toEqual([200, 400])
    const exchanged = exchanges.find(({ ok }) => ok)!
    const originalConnections = await listConnections(origin, "alice")
    expect(originalConnections).toEqual([
      expect.objectContaining({
        name: "OpenCode",
        authorisedAt: expect.any(Number),
      }),
    ])
    const { access_token, refresh_token } = await exchanged.json()
    await expectFreshDashboardStatus(origin, access_token, 200)
    const renewal = { grant_type: "refresh_token", refresh_token }
    const unavailable = await requestToken(renewal)
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toEqual({
      error: "temporarily_unavailable",
    })
    graphqlAvailable = false
    metadataAvailable = false
    const metadataFailure = await requestToken(renewal)
    expect(metadataFailure.status).toBe(503)
    expect(await metadataFailure.json()).toEqual({
      error: "temporarily_unavailable",
    })
    metadataAvailable = true
    // An issued grant keeps its registration alive beyond the unused TTL.
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 3_600_000)
    const renewed = await requestToken(renewal).finally(() =>
      clock.mockRestore(),
    )
    expect(renewed.status).toBe(200)
    expect(await listConnections(origin, "alice")).toEqual(originalConnections)
    expect(await renewed.json()).toMatchObject({ scope: "work:read" })
    expect(await (await requestToken(renewal)).json()).toEqual({
      error: "invalid_grant",
    })
    expect(submittedIssuerTokens).toEqual([
      "issuer-refresh",
      "issuer-refresh",
      "rotated-issuer-refresh",
    ])
    const { clientId, id: grantId } = originalConnections[0]!
    expect(
      await disconnectConnection({
        origin,
        userId: "alice",
        clientId,
        grantId,
      }),
    ).toBe(true)
    await expectFreshDashboardStatus(origin, access_token, 401)
  } finally {
    metadataAvailable = true
    issuer.mockRestore()
    if (env === undefined) delete process.env["PF_RUNTIME_MODE"]
    else process.env["PF_RUNTIME_MODE"] = env
  }
}

test.each(["local", "deployed"] as const)(
  "%s MCP grants persist across Dashboard instances and refresh outages until disconnected",
  verifyGrantLifecycle,
)

test("unused registrations stop occupying capacity once they expire", async () => {
  const origin = "http://localhost:3002"
  const redirect = "http://127.0.0.1:3001/callback"
  const env = process.env["PF_RUNTIME_MODE"]
  let now = Date.now()
  const clock = spyOn(Date, "now").mockImplementation(() => now)
  const registerClient = () =>
    register(
      new Request(`${origin}/mcp/register`, {
        method: "POST",
        body: JSON.stringify({
          client_name: "OpenCode",
          redirect_uris: [redirect],
        }),
      }),
      origin,
    )
  process.env["PF_RUNTIME_MODE"] = "local"
  try {
    expect((await registerClient()).status).toBe(201)
    // Fill the remaining slots without rescanning the bucket on every request.
    const clients = bucket(origin, "client", Schema.Unknown)
    const laterExpiry = now + 2 * 60 * 60 * 1000
    const client = { name: "OpenCode", redirects: [redirect], grants: [] }
    for (let index = 0; index < 1023; index++)
      await clients.put(`fixture-${index}`, client, laterExpiry)
    expect((await registerClient()).status).toBe(503)
    now += 60 * 60 * 1000
    expect((await registerClient()).status).toBe(201)
  } finally {
    clock.mockRestore()
    if (env === undefined) delete process.env["PF_RUNTIME_MODE"]
    else process.env["PF_RUNTIME_MODE"] = env
  }
})
