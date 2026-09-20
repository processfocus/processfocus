import { afterEach, expect, mock, test } from "bun:test"

mock.module("server-only", () => ({}))
mock.module("@/lib/auth/issuer", () => ({
  getFrontendAuthClientConfig: () => ({
    issuer: "https://auth.example.test",
    jwt: "confidential-client",
  }),
}))
const { isSecretLoginEnabled } = await import(
  "../lib/auth/secret-login-presentation"
)
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

test("reads trusted capability without caching or redemption", async () => {
  const request = mock(async () => Response.json({ secretLoginEnabled: true }))
  globalThis.fetch = request
  expect(await isSecretLoginEnabled()).toBe(true)
  expect(await isSecretLoginEnabled()).toBe(true)
  expect(request).toHaveBeenCalledTimes(2)
  expect(request).toHaveBeenCalledWith(
    "https://auth.example.test/oauth/delegation/availability",
    expect.objectContaining({
      method: "GET",
      headers: {
        Authorization: "Bearer confidential-client",
      },
      cache: "no-store",
      redirect: "error",
    }),
  )
  globalThis.fetch = mock(async () =>
    Response.json({ secretLoginEnabled: false }),
  )
  expect(await isSecretLoginEnabled()).toBe(false)
})

test.each([
  {},
  null,
  { secretLoginEnabled: "true" },
  { secretLoginEnabled: false },
  { enabled: true },
])("fails closed for %j", async (body) => {
  globalThis.fetch = mock(async () => Response.json(body))
  expect(await isSecretLoginEnabled()).toBe(false)
})

test.each([401, 403, 404, 500])("fails closed for HTTP %i", async (status) => {
  globalThis.fetch = mock(async () => new Response(null, { status }))
  expect(await isSecretLoginEnabled()).toBe(false)
})

test("fails closed for network failures and malformed JSON", async () => {
  globalThis.fetch = mock(async () => {
    throw new Error("unavailable")
  })
  expect(await isSecretLoginEnabled()).toBe(false)
  globalThis.fetch = mock(async () => new Response("not json"))
  expect(await isSecretLoginEnabled()).toBe(false)
})
