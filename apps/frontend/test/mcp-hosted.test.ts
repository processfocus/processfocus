import { NextRequest } from "next/server"
import { afterAll, beforeAll, expect, mock, test } from "bun:test"

mock.module("server-only", () => ({}))

const { proxy } = await import("../proxy")
const { GET, POST } = await import("../app/mcp/[[...endpoint]]/route")
const previousMode = process.env["PF_RUNTIME_MODE"]
const previousDomain = process.env["PF_MCP_DOMAIN"]

beforeAll(() => {
  process.env["PF_RUNTIME_MODE"] = "deployed"
})

afterAll(() => {
  if (previousMode === undefined) delete process.env["PF_RUNTIME_MODE"]
  else process.env["PF_RUNTIME_MODE"] = previousMode
  if (previousDomain === undefined) delete process.env["PF_MCP_DOMAIN"]
  else process.env["PF_MCP_DOMAIN"] = previousDomain
})

test.each([
  "backend.processfocus.com",
  "dev.example-project.app.processfocus.com",
  "work.customer.example",
])(
  "unauthenticated MCP clients can discover their issuer on %s",
  async (host) => {
    process.env["PF_MCP_DOMAIN"] = host
    const origin = `https://${host}`
    const request = (path: string, method = "GET") =>
      new NextRequest(`${origin}${path}`, { method, headers: { host } })
    const route = async (path: string, method = "GET") => {
      const response = await proxy(request(path, method))
      const rewrite = response.headers.get("x-middleware-rewrite")
      const target = new URL(rewrite ?? path, origin)
      expect(response.headers.get("location")).toBeNull()
      return (method === "POST" ? POST : GET)(
        request(target.pathname, method),
        {
          params: Promise.resolve({
            endpoint: target.pathname.split("/").slice(2),
          }),
        },
      )
    }
    for (const method of ["GET", "POST"]) {
      const response = await route("/mcp", method)
      expect(response.status).toBe(401)
      expect(response.headers.get("www-authenticate")).toBe(
        `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
      )
    }
    const resource = await route("/.well-known/oauth-protected-resource/mcp")
    expect(resource.status).toBe(200)
    expect(await resource.json()).toMatchObject({
      resource: `${origin}/mcp`,
      authorization_servers: [`${origin}/mcp`],
    })
    const metadata = await route("/.well-known/oauth-authorization-server/mcp")
    expect(metadata.status).toBe(200)
    expect(await metadata.json()).toMatchObject({
      issuer: `${origin}/mcp`,
      authorization_endpoint: `${origin}/mcp/authorize`,
      registration_endpoint: `${origin}/mcp/register`,
      token_endpoint: `${origin}/mcp/token`,
      code_challenge_methods_supported: ["S256"],
    })
    // The unscoped well-known URL belongs to OpenAuth at CloudFront.
    const rootMetadata = await proxy(
      request("/.well-known/oauth-authorization-server"),
    )
    expect(rootMetadata.headers.get("x-middleware-rewrite")).toBeNull()
    const wrongOrigin = await GET(
      new NextRequest(`${origin}/mcp`, {
        headers: { host, origin: "https://untrusted.example" },
      }),
      { params: Promise.resolve({}) },
    )
    expect(wrongOrigin.status).toBe(404)
  },
)
