import { createHash, randomBytes } from "node:crypto"
import { Schema } from "effect"
import { NextRequest } from "next/server"
import { OAuthMetadataFetchError } from "@pf/openauth/error"
import { expect, mock, spyOn, test } from "bun:test"

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
const graphqlEndpoint = "http://localhost:4000/graphql"
mock.module("@/lib/graphql/endpoint", () => ({
  getGraphqlEndpoint: () => graphqlEndpoint,
}))

const { authorize, consent, finishMcpLogin, register, token } = await import(
  "../lib/mcp/oauth"
)
const { bucket } = await import("../lib/mcp/store")

test("renewal survives issuer and metadata outages without depending on GraphQL availability", async () => {
  const origin = "http://localhost:3000"
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
  const issuer = spyOn(globalThis, "fetch").mockImplementation(
    async (input, init) => {
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
  process.env["PF_RUNTIME_MODE"] = "local"
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
        headers: { host: "localhost:3000", cookie: browserCookie ?? "" },
      }),
      returnTo,
      issuerTokens,
    )
    const approved = await consent(
      new NextRequest(signedIn?.headers.get("location") ?? "", {
        method: "POST",
        headers: {
          host: "localhost:3000",
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
    const exchanged = await requestToken({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirect,
    })
    expect(exchanged.status).toBe(200)
    const { refresh_token } = await exchanged.json()
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
    expect(await renewed.json()).toMatchObject({ scope: "work:read" })
    expect(await (await requestToken(renewal)).json()).toEqual({
      error: "invalid_grant",
    })
    expect(submittedIssuerTokens).toEqual([
      "issuer-refresh",
      "issuer-refresh",
      "rotated-issuer-refresh",
    ])
  } finally {
    metadataAvailable = true
    issuer.mockRestore()
    if (env === undefined) delete process.env["PF_RUNTIME_MODE"]
    else process.env["PF_RUNTIME_MODE"] = env
  }
})

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
