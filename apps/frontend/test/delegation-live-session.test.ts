import type { ProviderUserSession } from "@pf/auth-session"
import { afterEach, expect, mock, test } from "bun:test"

mock.module("server-only", () => ({}))
mock.module("@/lib/auth/issuer", () => ({
  getFrontendAuthClientConfig: () => ({
    issuer: "https://auth.example.test",
    jwt: "confidential-client",
  }),
}))
const { acceptVerifiedSession } = await import("../lib/auth/ssr-session")
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})
const human: ProviderUserSession = {
  userId: "owner",
  email: "owner@example.test",
  orgUnitId: "org",
  orgUnitPath: "/",
  roles: ["/OldRole"],
}
const session: ProviderUserSession = {
  ...human,
  delegation: {
    id: "delegate",
    generationId: "generation",
    name: "old-name",
    expiresAt: 2_000_000_000_000,
  },
}
const tokenFor = (properties: unknown, exp = 2_000_000_000) =>
  `header.${Buffer.from(JSON.stringify({ properties, exp })).toString("base64url")}.signature`
const token = tokenFor(session)

test("current issuer facts replace stale role/name/org facts without caching", async () => {
  const current = {
    ...session,
    roles: ["/CurrentRole"],
    orgUnitPath: "/current",
    delegation: { ...session.delegation, name: "renamed" },
  }
  const request = mock(async () => Response.json({ session: current }))
  globalThis.fetch = request
  expect(await acceptVerifiedSession(session, token)).toEqual(current)
  expect(await acceptVerifiedSession(session, token)).toEqual(current)
  expect(request).toHaveBeenCalledTimes(2)
  expect(request).toHaveBeenCalledWith(
    "https://auth.example.test/oauth/delegation/session",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ accessToken: token }),
      headers: {
        Authorization: "Bearer confidential-client",
        "Content-Type": "application/json",
      },
      cache: "no-store",
      redirect: "error",
    }),
  )
})

test.each([403, 401, 500])(
  "unavailable or invalid issuer response %i fails closed",
  async (status) => {
    globalThis.fetch = mock(async () => new Response(null, { status }))
    expect(await acceptVerifiedSession(session, token)).toBeNull()
  },
)

test.each([
  {},
  { session: human },
  { session: { ...session, roles: "invalid" } },
  { session: { ...session, userId: "another-owner" } },
  { session: { ...session, email: "another@example.test" } },
  {
    session: {
      ...session,
      delegation: { ...session.delegation, id: "another" },
    },
  },
  {
    session: {
      ...session,
      delegation: { ...session.delegation, generationId: "another" },
    },
  },
  {
    session: {
      ...session,
      delegation: { ...session.delegation, expiresAt: 2_000_000_001_000 },
    },
  },
  {
    session: {
      ...session,
      humanAuthentication: {
        providerUserId: "owner",
        method: "passkey",
        authenticatedAt: 1,
      },
    },
  },
])("malformed, human or mismatched lineage facts fail closed", async (body) => {
  globalThis.fetch = mock(async () => Response.json(body))
  expect(await acceptVerifiedSession(session, token)).toBeNull()
})

test("a frontend marker cannot launder a signed human token or strip a delegation", async () => {
  const request = mock(async () => Response.json({ session }))
  globalThis.fetch = request
  expect(await acceptVerifiedSession(session, tokenFor(human))).toBeNull()
  expect(await acceptVerifiedSession(human, token)).toBeNull()
  expect(request).not.toHaveBeenCalled()
})

test("access expiry cannot exceed the generation deadline", async () => {
  globalThis.fetch = mock(async () => Response.json({ session }))
  expect(
    await acceptVerifiedSession(session, tokenFor(session, 2_000_000_001)),
  ).toBeNull()
})

test("transport exceptions cannot leak tokens or become human sessions", async () => {
  globalThis.fetch = mock(async () => {
    throw new Error(token)
  })
  expect(await acceptVerifiedSession(session, token)).toBeNull()
  expect(await acceptVerifiedSession(human, tokenFor(human))).toEqual(human)
})
