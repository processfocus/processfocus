import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

const deadline = Date.now() + 120_000
const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(deadline / 1000) })).toString("base64url")}.signature`
const delegation = {
  id: "delegate",
  generationId: "generation",
  name: "agent",
  expiresAt: deadline,
}
const properties = {
  userId: "owner",
  email: "owner@example.test",
  roles: [],
  orgUnitId: "org",
  orgUnitPath: "/",
  delegation,
}
let subject: unknown = { type: "providerUser", properties }
const setSessionCookies = mock(async () => undefined)
mock.module("@/lib/auth/session", () => ({ setSessionCookies }))
mock.module("@/lib/auth/issuer", () => ({
  getFrontendAuthClientConfig: () => ({
    issuer: "https://auth.example.test",
    jwt: "confidential-client",
  }),
}))
mock.module("@/lib/auth/client", () => ({
  getAuthClient: () => ({ verify: async () => ({ err: false, subject }) }),
}))
const { POST } = await import("../app/api/auth/delegation/route")
const originalFetch = globalThis.fetch
const secret = `pfds_${"a".repeat(43)}`
const request = (
  body: unknown = { secret },
  headers: Record<string, string> = {},
) =>
  new Request("https://dashboard.example.test/api/auth/delegation", {
    method: "POST",
    headers: {
      origin: "https://dashboard.example.test",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  setSessionCookies.mockClear()
  subject = { type: "providerUser", properties }
})
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("secret-only protected exchange", () => {
  test("exchanges in POST body with confidential client JWT and bounded cookies", async () => {
    const upstream = mock(async () =>
      Response.json({
        access_token: token,
        refresh_token: "refresh",
        expires_in: 600,
        refresh_expires_in: 9000,
      }),
    )
    globalThis.fetch = upstream
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({ success: true })
    expect(upstream).toHaveBeenCalledWith(
      "https://auth.example.test/oauth/delegation",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ secret }),
        cache: "no-store",
        redirect: "error",
        headers: {
          Authorization: "Bearer confidential-client",
          "Content-Type": "application/json",
        },
      }),
    )
    expect(setSessionCookies).toHaveBeenCalledWith(
      expect.objectContaining({
        access: token,
        refresh: "refresh",
        expiresIn: expect.any(Number),
        refreshExpiresIn: expect.any(Number),
      }),
    )
  })

  test.each([
    [{ secret, email: "owner@example.test" }, {}],
    [{ secret: "wrong" }, {}],
    [{ secret }, { origin: "https://attacker.example.test" }],
    [{ secret }, { "content-type": "text/plain" }],
    [{ secret: "a".repeat(1100) }, {}],
  ])(
    "rejects invalid input before contacting issuer",
    async (body, headers) => {
      const upstream = mock(async () => Response.json({}))
      globalThis.fetch = upstream
      const response = await POST(request(body, headers))
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(upstream).not.toHaveBeenCalled()
      expect(setSessionCookies).not.toHaveBeenCalled()
    },
  )

  test.each([400, 401, 403, 429, 500])(
    "does not establish a session for issuer rejection %i",
    async (status) => {
      globalThis.fetch = mock(async () => new Response(secret, { status }))
      const response = await POST(request())
      expect(await response.text()).not.toContain(secret)
      expect(setSessionCookies).not.toHaveBeenCalled()
    },
  )

  test("does not accept a human session from secret exchange", async () => {
    subject = {
      type: "providerUser",
      properties: { ...properties, delegation: undefined },
    }
    globalThis.fetch = mock(async () =>
      Response.json({
        access_token: token,
        refresh_token: "refresh",
        expires_in: 60,
        refresh_expires_in: 60,
      }),
    )
    expect((await POST(request())).status).toBe(401)
    expect(setSessionCookies).not.toHaveBeenCalled()
  })

  test("suppresses exception details that might contain the secret", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error(secret)
    })
    const response = await POST(request())
    expect(await response.text()).toBe('{"success":false}')
    expect(setSessionCookies).not.toHaveBeenCalled()
  })
})
