import type { Session } from "@pf/auth-session"
import { getRealtimeRecipientId } from "@pf/auth-session/realtime-recipient"
import { getSessionCacheScope } from "../lib/auth/session-cache-scope"

mock.module("@/lib/auth/ssr-session", () => ({
  acceptVerifiedSession: async (session: Session) => session,
}))

import { beforeEach, expect, mock, test } from "bun:test"

const properties = {
  userId: "owner",
  email: "owner@example.test",
  roles: ["/Worker"],
  orgUnitId: "org",
  orgUnitPath: "/",
  delegation: {
    id: "delegate",
    generationId: "generation",
    name: "agent",
    expiresAt: Date.now() + 120_000,
  },
  delegationRoleSelection: ["/Worker"],
}
const expiry = Math.floor(Date.now() / 1000) + 60
const tokenFor = (session: Session) =>
  `header.${Buffer.from(JSON.stringify({ properties: session, exp: expiry })).toString("base64url")}.signature`
const tokens = {
  access: tokenFor(properties),
  refresh: "rotated",
  expiresIn: 60,
  refreshExpiresIn: 100,
}
let rejected = false
let refreshedSession: Session = properties
let missingAccess = false
const refresh = mock(async () =>
  rejected ? { err: true } : { err: false, tokens },
)
const setTokenCookies = mock(async () => undefined)
const deleted = mock(() => undefined)
const names = {
  accessToken: "access_token_3456",
  refreshToken: "refresh_token_3456",
}
mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === names.refreshToken
        ? { value: "refresh" }
        : name === names.accessToken && !missingAccess
          ? { value: "current-access" }
          : undefined,
    delete: deleted,
  }),
}))
mock.module("@/lib/auth/session", () => ({
  getCookieNames: async () => names,
  setTokenCookies,
}))
mock.module("@/lib/auth/client", () => ({
  getAuthClient: () => ({
    refresh,
    verify: async () => ({
      err: false,
      subject: {
        type: "providerUser",
        properties: refreshedSession,
      },
    }),
  }),
}))
const { POST } = await import("../app/api/auth/refresh/route")
const request = (origin = "https://dashboard.example.test") =>
  new Request("https://dashboard.example.test/api/auth/refresh", {
    method: "POST",
    headers: {
      origin,
    },
  })

beforeEach(() => {
  rejected = false
  missingAccess = false
  refreshedSession = properties
  tokens.access = tokenFor(properties)
  refresh.mockClear()
  deleted.mockClear()
  setTokenCookies.mockClear()
})

test("refresh uses host-aware cookies and preserves issuer-bounded lineage and cache scope", async () => {
  const response = await POST(request())
  expect(refresh).toHaveBeenCalledWith("refresh")
  expect(setTokenCookies).toHaveBeenCalledWith(expect.anything(), tokens)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(await response.json()).toMatchObject({
    success: true,
    cacheScope: getSessionCacheScope(properties),
    expiresAt: expiry,
    recipientId: await getRealtimeRecipientId(properties, expiry),
  })
})

test("rejected refresh clears only this runtime's access and refresh cookies", async () => {
  rejected = true
  expect(await (await POST(request())).json()).toEqual({
    success: false,
    redirect: "/login",
  })
  expect(deleted.mock.calls).toEqual([
    [names.accessToken],
    [names.refreshToken],
  ])
  expect(setTokenCookies).not.toHaveBeenCalled()
})

test("cross-origin refresh is rejected before touching credentials", async () => {
  expect((await POST(request("https://other.example.test"))).status).toBe(403)
  expect(refresh).not.toHaveBeenCalled()
  expect(setTokenCookies).not.toHaveBeenCalled()
  expect(deleted).not.toHaveBeenCalled()
})

test("live role changes are returned as the new cache scope", async () => {
  refreshedSession = { ...properties, roles: ["/Administrator"] }
  tokens.access = tokenFor(refreshedSession)
  const response = await POST(request())
  expect(response.status).toBe(200)
  expect(setTokenCookies).toHaveBeenCalledTimes(1)
  expect(deleted).not.toHaveBeenCalled()
  expect(await response.json()).toMatchObject({
    success: true,
    cacheScope: getSessionCacheScope(refreshedSession),
  })
})

test.each(["roles", "name"])(
  "reissued token must match live %s facts before setting cookies",
  async (fact) => {
    refreshedSession =
      fact === "roles"
        ? { ...properties, roles: ["/Administrator"] }
        : {
            ...properties,
            delegation: { ...properties.delegation, name: "renamed" },
          }
    // A valid but stale JWT cannot be paired with newer issuer facts.
    expect(await (await POST(request())).json()).toEqual({
      success: false,
      redirect: "/login",
    })
    expect(setTokenCookies).not.toHaveBeenCalled()
    tokens.access = tokenFor(refreshedSession)
    const response = await POST(request())
    expect(await response.json()).toMatchObject({
      success: true,
      expiresAt: expiry,
      recipientId: await getRealtimeRecipientId(refreshedSession, expiry),
    })
    expect(setTokenCookies).toHaveBeenCalledTimes(1)
  },
)

test("refresh works after the access cookie expires without an authority header", async () => {
  missingAccess = true
  expect((await POST(request())).status).toBe(200)
  expect(refresh).toHaveBeenCalledWith("refresh")
  expect(setTokenCookies).toHaveBeenCalledTimes(1)
})
