import { type NextRequest, NextResponse } from "next/server"
import { getIssuerUrl } from "@/lib/auth/client"
import { getCookieNamesFromHost } from "@/lib/auth/session"

const SIGNED_IN_MESSAGE =
  "Sign out before using a Registration Link to create a passkey."

const clearRegistrationSessionCookie = (
  response: NextResponse,
  cookieName: string,
): void => {
  response.cookies.delete({
    name: cookieName,
    path: "/api/auth/passkey",
  })
}

/**
 * Verifies a WebAuthn registration response and completes passkey enrollment.
 *
 * Proxies to the OpenAuth server's passkey/register-verify endpoint.
 * On success, the passkey is stored and the user is authenticated.
 *
 * @route POST /api/auth/passkey/register-verify
 */
export const POST = async (request: NextRequest) => {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >
    const issuerUrl = getIssuerUrl()
    const {
      passkeyAuthCookies: PAC,
      registrationSession: RS,
      accessToken: AT,
    } = getCookieNamesFromHost(request.headers.get("host") ?? "")

    const cookieSessionRaw = request.cookies.get(RS)?.value
    const cookieSession =
      typeof cookieSessionRaw === "string" ? cookieSessionRaw.trim() : ""
    const bodySession =
      typeof body["sessionBearer"] === "string"
        ? body["sessionBearer"].trim()
        : ""
    const sessionBearer = cookieSession || bodySession
    const accessToken = request.cookies.get(AT)?.value
    const invitationMode = sessionBearer.length > 0

    // Invitation registration cannot complete while a Provider User session is
    // active (revalidate signed-out state at verification).
    if (invitationMode && accessToken) {
      const denied = NextResponse.json(
        { error: SIGNED_IN_MESSAGE },
        { status: 403 },
      )
      clearRegistrationSessionCookie(denied, RS)
      return denied
    }

    // Get the auth server cookies that were stored by /start
    const authCookies = request.cookies.get(PAC)?.value ?? ""

    // Re-supply the Registration Session bearer (cookie preferred, body fallback)
    // so the auth server never needs to store the raw bearer on the challenge.
    const verifyBody =
      invitationMode && typeof body === "object" && body !== null
        ? { ...body, sessionBearer }
        : body

    const response = await fetch(`${issuerUrl}/oauth/passkey/register-verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookies,
      },
      body: JSON.stringify(verifyBody),
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

        // Clear Registration Session after successful Invitation registration.
        clearRegistrationSessionCookie(nextResponse, RS)

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

    const nextResponse = NextResponse.json(data, { status: response.status })
    // Invalid/expired invitation sessions should not linger in the browser.
    if (invitationMode && response.status >= 400 && response.status < 500) {
      clearRegistrationSessionCookie(nextResponse, RS)
    }
    return nextResponse
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error"
    console.error("Passkey register verify error:", {
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
    })
    return NextResponse.json(
      { error: "Failed to verify registration. Please try again." },
      { status: 500 },
    )
  }
}
