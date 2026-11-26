import { expect, mock, test } from "bun:test"

mock.module("server-only", () => ({}))
mock.module("next/cache", () => ({ cacheTag: () => {} }))
mock.module("@pf/auth-session", () => ({
  getFrontendJwt: () => "frontend-test-token",
}))

const { getPublicOrgIdentity } = await import("../lib/org-identity")

test.each([true, false])(
  "login GraphQL retries a 502 once (backend recovers: %s)",
  async (recovers) => {
    const requests: number[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        requests.push(performance.now())
        if (recovers && requests.length > 1) {
          return Response.json({
            data: { org: { name: "School", acronym: null } },
          })
        }
        return new Response("Internal Server Error", { status: 502 })
      },
    })
    const previousEndpoint = process.env["GRAPHQL_ENDPOINT"]
    const previousBaseUrl = process.env["BASE_URL"]
    process.env["GRAPHQL_ENDPOINT"] = new URL("/graphql", server.url).href
    delete process.env["BASE_URL"]
    try {
      const result = getPublicOrgIdentity()
      if (recovers) {
        await expect(result).resolves.toEqual({ name: "School", acronym: null })
      } else {
        await expect(result).rejects.toThrow("GraphQL Error (Code: 502)")
      }
      expect(requests).toHaveLength(2)
      const delay = requests[1]! - requests[0]!
      expect(delay).toBeGreaterThanOrEqual(200)
      expect(delay).toBeLessThan(1_000)
    } finally {
      await server.stop(true)
      if (previousEndpoint === undefined) delete process.env["GRAPHQL_ENDPOINT"]
      else process.env["GRAPHQL_ENDPOINT"] = previousEndpoint
      if (previousBaseUrl !== undefined)
        process.env["BASE_URL"] = previousBaseUrl
    }
  },
)
