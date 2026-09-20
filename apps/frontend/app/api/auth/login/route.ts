import { type NextRequest, NextResponse } from "next/server"
import { getAuthClient } from "@/lib/auth/client"
import { getValidRedirect } from "@/lib/auth/redirect"
import { getCookieNamesFromHost } from "@/lib/auth/session"

/**
 * We get here when the user clicks the login button on the /login page.
 */
export const POST = async (request: NextRequest) => {
  const url = new URL(request.url)

  // Extract provider and redirect from request body
  const body = (await request.json().catch(() => ({}))) as {
    provider?: string
    redirect?: string
  }
  const provider = body.provider
  const redirect = getValidRedirect(body.redirect)

  // Include redirect in callback URI so it comes back after OAuth
  const callbackUrl = new URL(`${url.protocol}//${url.host}/api/auth/callback`)
  if (redirect !== "/") {
    callbackUrl.searchParams.set("redirect", redirect)
  }
  const redirectURI = callbackUrl.toString()

  const authClient = getAuthClient()
  // Disable PKCE for confidential clients - client secret provides security
  const result = await authClient.authorize(redirectURI, "code", {
    pkce: false,
    provider,
  })

  const response = NextResponse.json({ url: result.url })

  // Store OAuth state in httpOnly cookie for CSRF protection
  const { oauthState: OS } = getCookieNamesFromHost(
    request.headers.get("host") ?? "",
  )
  response.cookies.set(OS, result.challenge.state, {
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    maxAge: 600, // 10 minutes
    path: "/api/auth/callback", // only this route can read this cookie
  })

  return response
}
