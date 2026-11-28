import type { NextRequest } from "next/server"

export const loopback = (url: URL): boolean =>
  url.protocol === "http:" &&
  ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
  !url.username &&
  !url.password

export const mcpOriginForHost = (host: string | null): string | undefined => {
  if (!host) return undefined
  if (process.env["PF_RUNTIME_MODE"] === "local") {
    try {
      const url = new URL(`http://${host}`)
      return loopback(url) && host === url.host ? url.origin : undefined
    } catch {
      return undefined
    }
  }
  if (process.env["PF_RUNTIME_MODE"] === "deployed") {
    // OpenNext restores Host from CloudFront's viewer-request function.
    const domain = process.env["PF_MCP_DOMAIN"]
    if (domain && host === domain) return `https://${domain}`
  }
  return undefined
}

export const mcpOrigin = (request: Request): string | undefined => {
  const origin = mcpOriginForHost(request.headers.get("host"))
  if (!origin || new URL(request.url).origin !== origin) return undefined
  const requestOrigin = request.headers.get("origin")
  return requestOrigin === null || requestOrigin === origin ? origin : undefined
}

export const connectedAppsPath = "/connected-apps"
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
