import { Effect, Schema } from "effect"
import { type NextRequest, NextResponse } from "next/server"
import { getAuthClient } from "@/lib/auth/client"
import { getValidRedirect } from "@/lib/auth/redirect"
import { getCookieNamesFromHost, getSessionWithToken } from "@/lib/auth/session"

/**
 * Initiates the OAuth flow for passkey authentication.
 *
 * This route must be called before any passkey registration or authentication.
 * It sets up the OAuth authorization state on the auth server and stores
 * the necessary cookies for subsequent passkey operations.
 *
 * @route POST /api/auth/passkey/start
 *
 * @requestBody
 * ```json
 * { "redirect": "/to-dos" }
 * ```
 *
 * @response 200 - Success
 * ```json
 * { "success": true }
 * ```
 *
 * @response 500 - Server error
 * ```json
 * { "error": "Failed to start passkey flow" }
 * ```
 *
 * @cookies Sets the following cookies:
 * - `oauth_state` or `oauth_state_<port>` on localhost - CSRF protection token
 * - `passkey_auth_cookies` or `passkey_auth_cookies_<port>` on localhost - auth server authorization cookies for proxying
 *
 * @example
 * ```typescript
 * const response = await fetch('/api/auth/passkey/start', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ redirect: '/dashboard' })
 * })
 * const data = await response.json() // { success: true }
 * ```
 */
export const POST = async (request: NextRequest) => {
  try {
    const url = new URL(request.url)

    // Extract redirect from request body
    const body = Schema.decodeUnknownSync(
      Schema.Struct({
        redirect: Schema.optional(Schema.String),
        purpose: Schema.optional(Schema.Literal("signin", "reauthenticate")),
      }),
    )(await request.json())
    const prior =
      body.purpose === "reauthenticate"
        ? await Effect.runPromise(
            getSessionWithToken.pipe(
              Effect.catchTags({
                NoAccessTokenError: () => Effect.succeed(null),
                JWTVerificationError: () => Effect.succeed(null),
              }),
            ),
          )
        : null
    if (body.purpose === "reauthenticate" && prior === null)
      return NextResponse.json(
        { error: "Your session is unavailable or has expired. Log in again." },
        { status: 401 },
      )
    if (prior && (!("email" in prior) || "delegation" in prior))
      return NextResponse.json(
        { error: "Use your human account to verify this action." },
        { status: 403 },
      )
    const redirect = getValidRedirect(body.redirect)

    // Include redirect in callback URI so it comes back after OAuth
    const callbackUrl = new URL(
      `${url.protocol}//${url.host}/api/auth/callback`,
    )
    if (redirect !== "/") {
      callbackUrl.searchParams.set("redirect", redirect)
    }
    const redirectURI = callbackUrl.toString()

    const authClient = getAuthClient()
    const result = await authClient.authorize(redirectURI, "code", {
      pkce: false,
      provider: "passkey",
    })

    // Call the auth server's authorize endpoint server-side
    // This sets up the authorization state (cookies) on the auth server
    const authResponse = await fetch(result.url, {
      method: "GET",
      redirect: "manual", // Don't follow redirects - we just want the cookies
    })

    // Create response
    const response = NextResponse.json({ success: true })
    const { oauthState: OS, passkeyAuthCookies: PAC } = getCookieNamesFromHost(
      request.headers.get("host") ?? "",
    )

    // Store OAuth state in httpOnly cookie for CSRF protection (on frontend)
    response.cookies.set(
      OS,
      prior === null
        ? result.challenge.state
        : JSON.stringify({
            state: result.challenge.state,
            accessToken: prior.accessToken,
          }),
      {
        httpOnly: true,
        secure: process.env["NODE_ENV"] === "production",
        sameSite: "lax",
        maxAge: 600, // 10 minutes
        path: "/api/auth/callback",
      },
    )

    // Capture the authorization cookie from auth server and store it
    // so we can forward it when proxying passkey requests
    const authCookies = authResponse.headers.getSetCookie()
    const authCookieValue = authCookies.join("; ")

    if (authCookieValue) {
      response.cookies.set(PAC, authCookieValue, {
        httpOnly: true,
        secure: process.env["NODE_ENV"] === "production",
        sameSite: "lax",
        maxAge: 600, // 10 minutes
        path: "/api/auth/passkey",
      })
    }

    return response
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error"
    console.error("Passkey start error:", {
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
    })
    return NextResponse.json(
      { error: "Failed to start passkey flow. Please try again." },
      { status: 500 },
    )
  }
}
