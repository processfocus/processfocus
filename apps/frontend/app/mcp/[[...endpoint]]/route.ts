import type { NextRequest } from "next/server"
import {
  authMetadata,
  authorize,
  challenge,
  consent,
  readMcpAccess,
  register,
  resourceMetadata,
  token,
} from "@/lib/mcp/oauth"
import { mcpOrigin } from "@/lib/mcp/origin"
import { handleMcp } from "@/lib/mcp/server"

type Context = { params: Promise<{ endpoint?: string[] }> }

async function handle(
  request: NextRequest,
  context: Context,
): Promise<Response> {
  const origin = mcpOrigin(request)
  if (!origin) return new Response(null, { status: 404 })
  const path = (await context.params).endpoint?.join("/") ?? ""
  if (path === "consent" && request.method !== "DELETE") return consent(request)
  if (request.method === "GET") {
    if (path === "authorize") return authorize(request, origin)
    if (path === "metadata") return authMetadata(origin)
    if (path === "resource") return resourceMetadata(origin)
  }
  if (request.method === "POST") {
    if (path === "register") return register(request, origin)
    if (path === "token") return token(request, origin)
  }
  if (path !== "") return new Response(null, { status: 404 })
  const access = await readMcpAccess(request, origin)
  if (!access) return challenge(origin)
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { Allow: "POST" } })
  const response = await handleMcp(request, access, origin)
  response.headers.set("Cache-Control", "no-store")
  return response
}

export { handle as GET, handle as POST, handle as DELETE }
