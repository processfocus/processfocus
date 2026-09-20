import { afterEach, expect, mock, test } from "bun:test"

const issuer = "https://auth.example.test"
const jwt = `header.${Buffer.from(JSON.stringify({ iss: issuer, aud: "graphql-api", properties: { clientId: "frontend" } })).toString("base64url")}.signature`
mock.module("@/lib/auth/issuer", () => ({
  getFrontendAuthClientConfig: () => ({ issuer, jwt }),
  getIssuerUrl: () => issuer,
  validateFrontendJwtIssuer: () => {},
}))
const { getAuthClient } = await import("../lib/auth/client")
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

test("the real cached issuer client authenticates routine, expiry-triggered and role-selection refresh", async () => {
  const requests: Request[] = []
  Reflect.set(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init))
      return Response.json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 60,
        token_type: "Bearer",
      })
    },
  )
  const client = getAuthClient()
  expect(getAuthClient()).toBe(client)
  expect((await client.refresh("refresh")).err).toBe(false)
  const expiredAccess = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.signature`
  expect((await client.refresh("refresh", { access: expiredAccess })).err).toBe(
    false,
  )
  expect(
    (await client.refresh("refresh", { scope: "roles:/Worker" })).err,
  ).toBe(false)
  expect(requests).toHaveLength(3)
  for (const request of requests) {
    expect(request.url).toBe(`${issuer}/oauth/token`)
    expect(request.headers.get("authorization")).toBe(`Bearer ${jwt}`)
    expect(request.headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    )
  }
  expect(await requests.at(-1)?.text()).toContain("scope=roles%3A%2FWorker")
})
