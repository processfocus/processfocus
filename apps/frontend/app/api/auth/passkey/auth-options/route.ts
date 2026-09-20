import { NextResponse } from "next/server"
import { getIssuerUrl } from "@/lib/auth/client"

/**
 * Generates WebAuthn authentication options for passkey login.
 *
 * Proxies to the OpenAuth server's passkey/auth-options endpoint.
 * The response contains the challenge and options needed to authenticate with a passkey.
 *
 * @route POST /api/auth/passkey/auth-options
 *
 * @requestBody
 * ```json
 * {}
 * ```
 * Authentication is usernameless. The browser identifies the account from a
 * discoverable credential selected by the user.
 *
 * @response 200 - Success
 * ```json
 * {
 *   "challengeId": "uuid-challenge-id",
 *   "options": {
 *     "challenge": "base64url-encoded-challenge",
 *     "rpId": "example.com",
 *     "timeout": 60000,
 *     "userVerification": "required"
 *   }
 * }
 * ```
 *
 * @response 500 - Server error
 * ```json
 * { "error": "Failed to generate authentication options" }
 * ```
 *
 * @example
 * ```typescript
 * const response = await fetch('/api/auth/passkey/auth-options', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({})
 * })
 * const { challengeId, options } = await response.json()
 * // Use options with navigator.credentials.get()
 * ```
 */
export const POST = async (_request: Request) => {
  try {
    const issuerUrl = getIssuerUrl()

    const response = await fetch(`${issuerUrl}/oauth/passkey/auth-options`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    })

    const data = await response.json()

    if (!response.ok) {
      return NextResponse.json(data, { status: response.status })
    }

    return NextResponse.json(data)
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error"
    console.error("Passkey auth options error:", {
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
    })
    return NextResponse.json(
      { error: "Failed to generate authentication options. Please try again." },
      { status: 500 },
    )
  }
}
