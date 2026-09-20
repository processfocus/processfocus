import { Data, Effect, Layer } from "effect"
import { NextRequest } from "next/server"
import { afterEach, describe, expect, mock, test } from "bun:test"

let verifiedUserId = "signed-in-user"
let priorInvalid = false
let sessionFailure:
  | "NoAccessTokenError"
  | "JWTVerificationError"
  | "unexpected"
  | null = null
const setCookies = mock(async () => {})

const authorize = mock(async (_redirectURI: string) => ({
  url: "https://auth.example.test/authorize",
  challenge: { state: "test-state" },
}))
const exchange = mock(async (_code: string, _redirectURI: string) => ({
  tokens: { access: "test-access", refresh: "test-refresh" },
}))
mock.module("@/lib/auth/client", () => ({
  getAuthClient: () => ({
    authorize,
    exchange,
    verify: async (_subjects: unknown, token: string) =>
      token === "prior-access" && priorInvalid
        ? { err: new Error("expired") }
        : {
            subject: {
              properties: {
                userId:
                  token === "prior-access" ? "signed-in-user" : verifiedUserId,
                email: "user@example.test",
                humanAuthentication: {
                  providerUserId: verifiedUserId,
                  method: "passkey",
                  authenticatedAt: Date.now(),
                },
              },
            },
          },
  }),
}))
mock.module("@/lib/auth/session", () => ({
  getCookieNamesFromHost: () => ({
    oauthState: "oauth_state",
    passkeyAuthCookies: "passkey_auth_cookies",
  }),
  setSessionCookies: setCookies,
  getSessionWithToken: Effect.suspend(() => {
    if (sessionFailure === "unexpected")
      return Effect.die(new Error("Unexpected session failure"))
    if (sessionFailure !== null)
      return Effect.fail(new (Data.TaggedError(sessionFailure))({}))
    return Effect.succeed({
      userId: "signed-in-user",
      email: "user@example.test",
      accessToken: "prior-access",
    })
  }),
}))
mock.module("@/lib/effect/run-effect", () => ({ runEffect: async () => true }))
mock.module("@/lib/effect/services", () => ({
  CedarAuthorizationLayer: Layer.empty,
}))

const { POST } = await import("../app/api/auth/passkey/start/route")
const { GET } = await import("../app/api/auth/callback/route")
const originalFetch = globalThis.fetch

describe("passkey redirect round trip", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
    authorize.mockClear()
    exchange.mockClear()
    setCookies.mockClear()
    verifiedUserId = "signed-in-user"
    priorInvalid = false
    sessionFailure = null
  })

  test.each([
    "NoAccessTokenError",
    "JWTVerificationError",
    "unexpected",
  ] as const)(
    "rejects reauthentication before OAuth when session lookup fails: %s",
    async (failure) => {
      sessionFailure = failure
      const fetchMock = mock(async () => new Response(null, { status: 302 }))
      globalThis.fetch = fetchMock
      const response = await POST(
        new NextRequest(
          "https://dashboard.example.test/api/auth/passkey/start",
          {
            method: "POST",
            body: JSON.stringify({ purpose: "reauthenticate" }),
          },
        ),
      )
      expect(response.status).toBe(failure === "unexpected" ? 500 : 401)
      expect(await response.json()).toEqual({
        error:
          failure === "unexpected"
            ? "Failed to start passkey flow. Please try again."
            : "Your session is unavailable or has expired. Log in again.",
      })
      expect(authorize).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
      expect(response.headers.get("set-cookie")).toBeNull()
      expect(setCookies).not.toHaveBeenCalled()
    },
  )

  test("ordinary sign-in can start without an existing session", async () => {
    sessionFailure = "NoAccessTokenError"
    globalThis.fetch = mock(async () => new Response(null, { status: 302 }))
    const response = await POST(
      new NextRequest("https://dashboard.example.test/api/auth/passkey/start", {
        method: "POST",
        headers: { host: "dashboard.example.test" },
        body: JSON.stringify({ purpose: "signin" }),
      }),
    )
    expect(response.status).toBe(200)
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(response.cookies.get("oauth_state")?.value).toBe("test-state")
  })

  test.each(["same-owner", "wrong-owner", "expired-prior"])(
    "reauthentication callback binds %s without replacing the session on failure",
    async (mode) => {
      globalThis.fetch = mock(async () => new Response(null, { status: 302 }))
      const started = await POST(
        new NextRequest(
          "https://dashboard.example.test/api/auth/passkey/start",
          {
            method: "POST",
            headers: { host: "dashboard.example.test" },
            body: JSON.stringify({
              redirect: "/act-on-behalf",
              purpose: "reauthenticate",
            }),
          },
        ),
      )
      const state = started.cookies.get("oauth_state")!.value
      expect(JSON.parse(state)).toEqual({
        state: "test-state",
        accessToken: "prior-access",
      })
      verifiedUserId =
        mode === "wrong-owner" ? "someone-else" : "signed-in-user"
      priorInvalid = mode === "expired-prior"
      const callback = new URL(authorize.mock.calls[0]![0])
      callback.searchParams.set("code", "test-code")
      callback.searchParams.set("state", "test-state")
      const result = await GET(
        new NextRequest(callback, {
          headers: {
            host: "dashboard.example.test",
            accept: "application/json",
            cookie: `oauth_state=${encodeURIComponent(state)}`,
          },
        }),
      )
      expect(result.status).toBe(mode === "same-owner" ? 200 : 403)
      expect(setCookies).toHaveBeenCalledTimes(mode === "same-owner" ? 1 : 0)
      expect(result.headers.get("location")).toBeNull()
      expect(result.cookies.get("oauth_state")?.value).toBe("")
      if (mode === "same-owner") {
        const replay = await GET(
          new NextRequest(callback, {
            headers: {
              host: "dashboard.example.test",
              accept: "application/json",
            },
          }),
        )
        expect(replay.status).toBe(307)
        expect(replay.headers.get("location")).toContain("invalid_state")
        expect(exchange).toHaveBeenCalledTimes(1)
        expect(setCookies).toHaveBeenCalledTimes(1)
      }
    },
  )

  test.each([
    "external|owner+id&not=a-query",
    "owner%2Fid#fragment?query=value\\suffix",
  ])(
    "preserves owner ID through start and callback: %s",
    async (ownerUserId) => {
      globalThis.fetch = mock(async () => new Response(null, { status: 302 }))
      const redirect = `/act-on-behalf?${new URLSearchParams({ ownerUserId })}`
      const response = await POST(
        new NextRequest(
          "https://dashboard.example.test/api/auth/passkey/start",
          {
            method: "POST",
            headers: { host: "dashboard.example.test" },
            body: JSON.stringify({ redirect }),
          },
        ),
      )
      expect(response.status).toBe(200)
      const redirectURI = authorize.mock.calls[0]?.[0]
      expect(redirectURI).toBeDefined()
      if (!redirectURI) throw new Error("Passkey start did not authorize")
      const callback = new URL(redirectURI)
      expect(callback.searchParams.get("redirect")).toBe(redirect)
      callback.searchParams.set("code", "test-code")
      callback.searchParams.set("state", "test-state")
      const completed = await GET(
        new NextRequest(callback, {
          headers: {
            host: "dashboard.example.test",
            cookie: "oauth_state=test-state",
          },
        }),
      )
      expect(exchange).toHaveBeenCalledWith("test-code", redirectURI)
      expect(completed.status).toBe(307)
      expect(completed.headers.get("location")).toBe(
        `https://dashboard.example.test${redirect}`,
      )
      const destination = new URL(completed.headers.get("location") ?? "")
      expect([...destination.searchParams]).toEqual([
        ["ownerUserId", ownerUserId],
      ])
      expect(destination.hash).toBe("")
    },
  )

  test.each([
    "https://evil.example.test",
    "//evil.example.test",
    "/%252Fevil.example.test",
    "/%255Cevil.example.test",
    "/safe%3F/../api/auth/logout",
    "/safe%23/../logout",
    "/safe%253F/%2e%2e/login",
  ])(
    "callback independently rejects an unsafe redirect: %s",
    async (redirect) => {
      const callback = new URL(
        "https://dashboard.example.test/api/auth/callback",
      )
      callback.search = new URLSearchParams({
        redirect,
        code: "test-code",
        state: "test-state",
      }).toString()
      const response = await GET(
        new NextRequest(callback, {
          headers: { cookie: "oauth_state=test-state" },
        }),
      )
      expect(response.headers.get("location")).toBe(
        "https://dashboard.example.test/",
      )
    },
  )
})
