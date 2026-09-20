import type { GraphQLClient } from "graphql-request"
import type { Session } from "@pf/auth-session"
import { beforeEach, expect, mock, test } from "bun:test"

mock.module("@/lib/auth/ssr-session", () => ({
  acceptVerifiedSession: async (session: Session) => session,
}))

let delegated = true
const human: Session = {
  userId: "owner",
  email: "owner@example.test",
  roles: ["/Assigned Role"],
  orgUnitId: "org",
  orgUnitPath: "/",
}
const delegate: Session = {
  ...human,
  delegation: {
    id: "delegate",
    generationId: "generation",
    name: "agent",
    expiresAt: 2_000_000_000_000,
  },
}
let rejected = false
const requestRole = mock(async (_client: GraphQLClient, _rolePath: string) => ({
  success: true,
}))
const refresh = mock(async () =>
  rejected
    ? { err: true }
    : {
        err: false,
        tokens: {
          access: "scoped-access",
          refresh: "scoped-refresh",
          expiresIn: 60,
          refreshExpiresIn: 100,
        },
      },
)
const setTokenCookies = mock(async () => undefined)
mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => ({
      value: name === "access" ? "access-token" : "refresh-token",
    }),
  }),
}))
mock.module("@/lib/auth/session", () => ({
  getCookieNames: async () => ({
    accessToken: "access",
    refreshToken: "refresh",
  }),
  setTokenCookies,
}))
mock.module("@/lib/graphql/provider-user-queries", () => ({ requestRole }))
mock.module("@/lib/graphql/endpoint", () => ({
  getGraphqlEndpoint: () => "https://graphql.example.test",
}))
mock.module("@/lib/auth/client", () => ({
  getAuthClient: () => ({
    refresh,
    verify: async () => ({
      err: false,
      subject: {
        properties: delegated ? delegate : human,
      },
    }),
  }),
}))
const { POST } = await import("../app/api/auth/switch-role/route")
const request = (origin = "https://dashboard.example.test") =>
  new Request("https://dashboard.example.test/api/auth/switch-role", {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
    },
    body: JSON.stringify({ rolePath: "/Assigned Role" }),
  })
beforeEach(() => {
  delegated = true
  rejected = false
  requestRole.mockClear()
  refresh.mockClear()
  setTokenCookies.mockClear()
})

test("delegated switching asks issuer for scoped refresh without creating human grants", async () => {
  expect(await (await POST(request())).json()).toMatchObject({ success: true })
  expect(requestRole).not.toHaveBeenCalled()
  expect(refresh).toHaveBeenCalledWith("refresh-token", {
    scope: "role:%2FAssigned%20Role",
  })
  expect(setTokenCookies).toHaveBeenCalledTimes(1)
})
test("issuer rejects revoked generations and unassigned delegated roles without changing cookies", async () => {
  rejected = true
  expect(await (await POST(request())).json()).toMatchObject({ success: false })
  expect(requestRole).not.toHaveBeenCalled()
  expect(setTokenCookies).not.toHaveBeenCalled()
})
test("human role requests retain the existing GraphQL authorization path", async () => {
  delegated = false
  expect(await (await POST(request())).json()).toMatchObject({ success: true })
  expect(requestRole).toHaveBeenCalledTimes(1)
  expect(requestRole.mock.calls[0]?.[0].requestConfig.headers).toMatchObject({
    Authorization: "Bearer access-token",
  })
})

test("cross-origin switch rejects before GraphQL or refresh work", async () => {
  expect((await POST(request("https://other.example.test"))).status).toBe(403)
  expect(requestRole).not.toHaveBeenCalled()
  expect(refresh).not.toHaveBeenCalled()
  expect(setTokenCookies).not.toHaveBeenCalled()
})

test("successful switch requires no authority header and returns no credentials", async () => {
  const response = await POST(request())
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(await response.text()).not.toContain("scoped-access")
})
