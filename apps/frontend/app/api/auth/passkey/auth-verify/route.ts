import { type NextRequest, NextResponse } from "next/server"
import { getIssuerUrl } from "@/lib/auth/client"
import { getCookieNamesFromHost } from "@/lib/auth/session"

/**
 * Verifies a WebAuthn authentication response and completes passkey login.
 *
 * Proxies to the OpenAuth server's passkey/auth-verify endpoint.
 * On success, the user is authenticated and the OAuth flow continues.
 *
 * @route POST /api/auth/passkey/auth-verify
 *
 * @prerequisites
 * - Must call `/api/auth/passkey/start` first to set up OAuth state cookies
 * - Must call `/api/auth/passkey/auth-options` to get the challenge
 *
 * @requestBody
 * ```json
 * {
 *   "challengeId": "uuid-from-auth-options",
 *   "response": {
 *     "id": "credential-id-base64url",
 *     "rawId": "credential-id-base64url",
 *     "type": "public-key",
 *     "response": {
 *       "clientDataJSON": "base64url-encoded",
 *       "authenticatorData": "base64url-encoded",
 *       "signature": "base64url-encoded",
 *       "userHandle": "base64url-encoded-user-id"
 *     },
 *     "clientExtensionResults": {}
 *   }
 * }
 * ```
 * @property {string} challengeId - The challenge ID from `/api/auth/passkey/auth-options`
 * @property {AuthenticationResponseJSON} response - The response from `navigator.credentials.get()`
 *
 * @response 200 - Success (authenticated, OAuth flow continues)
 * ```json
 * {
 *   "success": true,
 *   "redirectUrl": "https://app.example.com/api/auth/callback?code=xxx&state=yyy"
 * }
 * ```
 *
 * @response 400 - Invalid request or verification failed
 * ```json
 * { "error": "Invalid request body" }
 * { "error": "Invalid or expired challenge" }
 * { "error": "Unknown credential" }
 * { "error": "Credential does not match user" }
 * { "error": "Verification failed" }
 * ```
 *
 * @response 500 - Server error
 * ```json
 * { "error": "Failed to verify authentication" }
 * ```
 *
 * @example
 * ```typescript
 * // After navigator.credentials.get() returns credential
 * const response = await fetch('/api/auth/passkey/auth-verify', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ challengeId, response: credential })
 * })
 * const { success, redirectUrl } = await response.json()
 * if (success) {
 *   window.location.href = redirectUrl // Complete OAuth flow
 * }
 * ```
 */
export const POST = async (request: NextRequest) => {
  try {
    const body = await request.json()
    const issuerUrl = getIssuerUrl()
    const { passkeyAuthCookies: PAC } = getCookieNamesFromHost(
      request.headers.get("host") ?? "",
    )

    // Get the auth server cookies that were stored by /start
    const authCookies = request.cookies.get(PAC)?.value ?? ""

    const response = await fetch(`${issuerUrl}/oauth/passkey/auth-verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookies,
      },
      body: JSON.stringify(body),
      redirect: "manual", // Don't follow redirects - we need to return the URL
    })

    // Success case: OpenAuth returns a redirect to our callback
    if (response.status === 302) {
      const location = response.headers.get("location")
      if (location) {
        // Return the redirect URL and any cookies to set
        const setCookieHeaders = response.headers.getSetCookie()
        const nextResponse = NextResponse.json({
          success: true,
          redirectUrl: location,
        })

        // Forward any cookies from the OpenAuth server
        for (const cookie of setCookieHeaders) {
          nextResponse.headers.append("Set-Cookie", cookie)
        }

        // Clean up the passkey auth cookies
        nextResponse.cookies.delete({
          name: PAC,
          path: "/api/auth/passkey",
        })

        return nextResponse
      }
    }

    // Error case: return the error from OpenAuth
    let data: Record<string, unknown>
    try {
      data = await response.json()
    } catch {
      data = { error: "Unknown error from auth server" }
    }

    return NextResponse.json(data, { status: response.status })
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error"
    console.error("Passkey auth verify error:", {
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
    })
    return NextResponse.json(
      { error: "Failed to verify authentication. Please try again." },
      { status: 500 },
    )
  }
}
