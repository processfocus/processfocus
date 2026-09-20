import { Effect } from "effect"
import { expect, mock, test } from "bun:test"

mock.module("server-only", () => ({}))
mock.module("@/lib/auth/issuer", () => ({
  getFrontendAuthClientConfig: () => ({
    issuer: "https://auth.example.test",
    jwt: "client-jwt",
  }),
}))
const originalFetch = globalThis.fetch

const human = {
  userId: "owner",
  email: "owner@example.test",
  roles: [],
  orgUnitId: "org",
  orgUnitPath: "/",
}
let delegated = true
const token = () =>
  `header.${Buffer.from(JSON.stringify({ exp: 2_000_000_000, properties: delegated ? { delegation: {} } : human })).toString("base64url")}.signature`
mock.module("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: token() }) }),
  headers: async () => new Headers({ host: "dashboard.example.test" }),
}))
mock.module("@/lib/auth/client", () => ({
  getAuthClient: () => ({
    verify: async () => ({
      err: false,
      subject: {
        type: "providerUser",
        properties: delegated
          ? {
              ...human,
              delegation: {
                id: "delegation",
                generationId: "generation",
                name: "agent",
                expiresAt: 2_000_000_000_000,
              },
            }
          : human,
      },
    }),
  }),
}))
const { getSessionWithToken, getSessionWithTokenAndExpiry } = await import(
  "../lib/auth/session"
)

test("both SSR accepting paths reject verified delegates without live facts", async () => {
  delegated = true
  globalThis.fetch = mock(async () => new Response(null, { status: 403 }))
  expect(await getSessionWithTokenAndExpiry()).toBeNull()
  expect(await Effect.runPromise(Effect.isFailure(getSessionWithToken))).toBe(
    true,
  )
  globalThis.fetch = originalFetch
})

test("human session remains independent of delegation availability", async () => {
  delegated = false
  expect(await getSessionWithTokenAndExpiry()).toMatchObject(human)
  expect(await Effect.runPromise(getSessionWithToken)).toMatchObject(human)
})

test("both SSR accepting paths return current trusted facts, not stale JWT roles", async () => {
  delegated = true
  const current = {
    ...human,
    roles: ["/CurrentRole"],
    orgUnitPath: "/current",
    delegation: {
      id: "delegation",
      generationId: "generation",
      name: "renamed",
      expiresAt: 2_000_000_000_000,
    },
  }
  globalThis.fetch = mock(async () => Response.json({ session: current }))
  try {
    expect(await getSessionWithTokenAndExpiry()).toMatchObject(current)
    expect(await Effect.runPromise(getSessionWithToken)).toMatchObject(current)
  } finally {
    globalThis.fetch = originalFetch
  }
})
