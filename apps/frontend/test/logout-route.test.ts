import { NextRequest } from "next/server"
import { afterEach, expect, mock, test } from "bun:test"

const jar = new Map<string, string>()
mock.module("server-only", () => ({}))
mock.module("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({
    get: (name: string) =>
      jar.has(name) ? { value: jar.get(name) } : undefined,
    delete: (name: string) => jar.delete(name),
  }),
}))
const issuer = await import("../lib/auth/issuer")
mock.module("@/lib/auth/issuer", () => ({
  ...issuer,
  getIssuerUrl: () => "https://auth.example",
}))

const { POST, GET } = await import("../app/api/auth/logout/route")
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  jar.clear()
})

// The actual session helper clears cookies; only Next's request context and
// the external authentication transport are substituted here.
test.each(["success", "http-failure", "transport-failure", "no-refresh"])(
  "current-session logout clears cookies and completes after %s",
  async (outcome) => {
    for (const method of ["POST", "GET"]) {
      jar.set("access_token_3000", "current-access")
      if (outcome !== "no-refresh")
        jar.set("refresh_token_3000", "current-refresh")
      jar.set("refresh_token_3001", "other-session")
      const requests: Request[] = []
      globalThis.fetch = Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => {
          requests.push(new Request(input, init))
          if (outcome === "transport-failure") throw new Error("offline")
          return Response.json(
            { success: true },
            { status: outcome === "http-failure" ? 500 : 200 },
          )
        },
        { preconnect: originalFetch.preconnect },
      )

      const response =
        method === "POST"
          ? await POST()
          : await GET(new NextRequest("http://localhost:3000/api/auth/logout"))
      expect(jar.has("access_token_3000")).toBe(false)
      expect(jar.has("refresh_token_3000")).toBe(false)
      expect(jar.get("refresh_token_3001")).toBe("other-session")
      if (method === "POST")
        expect(await response.json()).toEqual({ success: true })
      else
        expect(response.headers.get("location")).toBe(
          "http://localhost:3000/login",
        )
      expect(requests).toHaveLength(outcome === "no-refresh" ? 0 : 1)
      if (requests[0]) {
        expect(requests[0].url).toBe("https://auth.example/oauth/logout")
        expect(requests[0].method).toBe("POST")
        expect(await requests[0].text()).toBe("token=current-refresh")
      }
    }
  },
)
