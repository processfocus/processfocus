import { Effect, Layer } from "effect"
import { NextRequest } from "next/server"
import { AuthorizationService } from "@pf/auth-policy"
import { afterAll, beforeEach, expect, mock, test } from "bun:test"

// Identity verification and Cedar are external to admission; cookie writing and
// the deployed balance client's HTTP request run through their real implementations.
mock.module("server-only", () => ({}))
let delegated = false
let passkey = false
const deadline = Date.now() + 120_000
const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(deadline / 1000) })).toString("base64url")}.signature`
const tokens = {
  access: token,
  refresh: "refresh",
  expiresIn: 60,
  refreshExpiresIn: 60,
}
const cookies = new Map<string, string>()
const writes = mock((name: string, value: string) => {
  cookies.set(name, value)
})
mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => ({ value: cookies.get(name) }),
    set: writes,
  }),
  headers: async () => new Headers({ host: "dashboard.example.test" }),
}))
mock.module("@/lib/auth/client", () => ({
  getAuthClient: () => ({
    exchange: async () => ({ err: false, tokens }),
    verify: async () => ({
      err: false,
      subject: {
        type: "providerUser",
        properties: {
          userId: "operator",
          email: "operator@example.test",
          roles: ["/Support", "/Administrator"],
          orgUnitId: "org",
          orgUnitPath: "/",
          ...(delegated
            ? {
                delegation: {
                  id: "delegate",
                  generationId: "generation",
                  name: "agent",
                  expiresAt: deadline,
                },
              }
            : passkey
              ? {
                  humanAuthentication: {
                    providerUserId: "operator",
                    method: "passkey",
                  },
                }
              : {}),
        },
      },
    }),
  }),
}))
let allowed = true
mock.module("@/lib/effect/services", () => ({
  CedarAuthorizationLayer: Layer.succeed(
    AuthorizationService,
    AuthorizationService.of({
      canManageDelegation: () => Effect.succeed(false),
      canIssueDelegationSecret: () => Effect.succeed(false),
      canListDelegationTokens: () => Effect.succeed(false),
      canLogin: () => Effect.succeed(allowed),
      canCompleteStep: () => Effect.succeed(false),
      canCompleteTodo: () => Effect.succeed(false),
      canCorrectPublicCompletionTodo: () => Effect.succeed(false),
      canCompletePublicTodo: () => Effect.succeed(false),
      canRequestRole: () => Effect.succeed(false),
      canRequestProviderUserPermissions: () => Effect.succeed(false),
      canActOnBehalfOf: () => Effect.succeed(false),
      canViewExecution: () => Effect.succeed(false),
      canRestartExecution: () => Effect.succeed(false),
      canAbandonStep: () => Effect.succeed(false),
      canDraftStep: () => Effect.succeed(false),
      canModifyField: () => Effect.succeed(false),
      canAccessField: () => Effect.succeed(false),
      canAccessFeature: () => Effect.succeed(false),
      canAccessList: () => Effect.succeed(false),
      canCreateList: () => Effect.succeed(false),
      canUpdateList: () => Effect.succeed(false),
      canDeleteList: () => Effect.succeed(false),
      canDownloadFile: () => Effect.succeed(false),
      canDeleteFile: () => Effect.succeed(false),
      canPerformAction: () => Effect.succeed(false),
    }),
  ),
}))
let balance: number | null = 1
let reads = 0
const backend = Bun.serve({
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname === "/oauth/delegation")
      return Response.json({
        access_token: token,
        refresh_token: "refresh",
        expires_in: 60,
        refresh_expires_in: 60,
      })
    reads++
    expect(new URL(request.url).pathname).toBe("/graphql")
    expect(request.headers.get("authorization")).toBe(
      "Bearer project-only-credential",
    )
    expect(await request.json()).toMatchObject({
      variables: { projectId: "stamped-project" },
    })
    return balance === null
      ? new Response("unavailable", { status: 500 })
      : Response.json({
          data: { getProjectBalance: { projectBalance: balance } },
        })
  },
})
mock.module("@/lib/auth/issuer", () => ({
  getFrontendAuthClientConfig: () => ({
    issuer: backend.url.origin,
    jwt: "frontend-credential",
  }),
}))
const envKeys = [
  "PF_PROJECT_BALANCE_BACKEND_ORIGIN",
  "PF_PROJECT_BALANCE_PROJECT_ID",
  "PF_PROJECT_BALANCE_CREDENTIAL",
]
const originalEnv = envKeys.map((key) => process.env[key])
const { GET } = await import("../app/api/auth/callback/route")
const { POST } = await import("../app/api/auth/delegation/route")
const { getCookieNamesFromHost } = await import("../lib/auth/session")
const names = getCookieNamesFromHost("dashboard.example.test")
const callback = (reauthenticate = false) =>
  GET(
    new NextRequest(
      "https://dashboard.example.test/api/auth/callback?code=code&state=state",
      {
        headers: {
          cookie: `${names.oauthState}=${encodeURIComponent(reauthenticate ? JSON.stringify({ state: "state", accessToken: token }) : "state")}`,
          ...(reauthenticate ? { accept: "application/json" } : {}),
        },
      },
    ),
  )
const secretLogin = () =>
  POST(
    new Request("https://dashboard.example.test/api/auth/delegation", {
      method: "POST",
      headers: {
        origin: "https://dashboard.example.test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ secret: `pfds_${"a".repeat(43)}` }),
    }),
  )
beforeEach(() => {
  process.env[envKeys[0]!] = backend.url.origin
  process.env[envKeys[1]!] = "stamped-project"
  process.env[envKeys[2]!] = "project-only-credential"
  balance = 1
  reads = 0
  allowed = true
  delegated = false
  cookies.clear()
  writes.mockClear()
})
afterAll(() => {
  backend.stop(true)
  envKeys.forEach((key, index) => {
    const value = originalEnv[index]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  })
})
for (const flow of [
  "identity-provider",
  "passkey",
  "reauthentication",
  "delegation",
]) {
  const login = () => {
    passkey = flow === "passkey" || flow === "reauthentication"
    delegated = flow === "delegation"
    return delegated ? secretLogin() : callback(flow === "reauthentication")
  }
  test.each([0, -0.001])(
    `${flow} refuses %s without session cookies or amounts`,
    async (amount) => {
      balance = amount
      const response = await login()
      expect(writes).not.toHaveBeenCalled()
      expect(reads).toBe(1)
      if (flow === "identity-provider" || flow === "passkey")
        expect(response.headers.get("location")).toEndWith(
          "/login?error=environment_unavailable",
        )
      else
        expect(await response.json()).toMatchObject({
          error: "environment_unavailable",
        })
    },
  )
  test.each([0.001, 25, null])(
    `${flow} admits %s and sets cookies`,
    async (amount) => {
      balance = amount
      await login()
      expect(reads).toBe(1)
      expect(cookies.get(names.accessToken)).toBe(token)
      expect(cookies.get(names.refreshToken)).toBe("refresh")
    },
  )
  test(`${flow} keeps admitted cookies and checks a later login again`, async () => {
    await login()
    const admitted = new Map(cookies)
    balance = 0
    writes.mockClear()
    await login()
    expect(reads).toBe(2)
    expect(writes).not.toHaveBeenCalled()
    expect(cookies).toEqual(admitted)
  })
  test(`${flow} local login does not read a balance`, async () => {
    envKeys.forEach((key) => {
      delete process.env[key]
    })
    await login()
    expect(reads).toBe(0)
    expect(cookies.get(names.accessToken)).toBe(token)
  })
}
test("role denial remains distinct and does not reach admission", async () => {
  allowed = false
  const response = await callback()
  expect(response.headers.get("location")).toEndWith(
    "/login?error=not_authorized",
  )
  expect(reads).toBe(0)
  expect(writes).not.toHaveBeenCalled()
})
