import type { NextRequest } from "next/server"

export const loopback = (url: URL): boolean =>
  url.protocol === "http:" &&
  ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
  !url.username &&
  !url.password

export const mcpOrigin = (request: Request): string | undefined => {
  const url = new URL(request.url)
  const host = request.headers.get("host")
  if (process.env["PF_RUNTIME_MODE"] === "local") {
    if (!loopback(url) || host !== url.host) return undefined
  } else if (process.env["PF_RUNTIME_MODE"] === "deployed") {
    // OpenNext restores Host from CloudFront's viewer-request function.
    // Neither header nor the request URL can choose a different issuer.
    const domain = process.env["PF_MCP_DOMAIN"]
    if (!domain || host !== domain || url.origin !== `https://${domain}`)
      return undefined
  } else {
    return undefined
  }
  const origin = request.headers.get("origin")
  return origin === null || origin === url.origin ? url.origin : undefined
}

export const consentPath = "/mcp/consent"
export const opaque = /^[A-Za-z0-9_-]{43}$/
export const cookieName = (origin: string, id: string): string =>
  origin.startsWith("https:")
    ? `__Host-pf_mcp_${id}`
    : `pf_mcp_${new URL(origin).port}_${id}`

// Let login run even with a Dashboard session: each grant needs its own
// human refresh chain, not a copy of the Dashboard's.
export const isMcpLogin = (request: NextRequest): boolean => {
  const origin = mcpOrigin(request)
  const redirect = request.nextUrl.searchParams.get("redirect")
  if (!origin || !redirect?.startsWith(`${consentPath}?`)) return false
  const id = new URL(redirect, origin).searchParams.get("id") ?? ""
  return opaque.test(id) && request.cookies.has(cookieName(origin, id))
}
