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
 * Generates WebAuthn registration options for passkey enrollment.
 *
 * Proxies to the OpenAuth server's passkey/register-options endpoint.
 * Open Registration supplies `{ email }`. Invitation registration supplies no
 * email and uses the Registration Session cookie from link exchange.
 *
 * @route POST /api/auth/passkey/register
 */
export const POST = async (request: NextRequest) => {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >
    const issuerUrl = getIssuerUrl()
    const { registrationSession: RS, accessToken: AT } = getCookieNamesFromHost(
      request.headers.get("host") ?? "",
    )

    const cookieSessionRaw = request.cookies.get(RS)?.value
    const cookieSession =
      typeof cookieSessionRaw === "string" ? cookieSessionRaw.trim() : ""
    const bodySession =
      typeof body["sessionBearer"] === "string"
        ? body["sessionBearer"].trim()
        : ""
    // Invitation authority may arrive via cookie (normal UI) or body (BFF/API).
    const sessionBearer = cookieSession || bodySession
    const accessToken = request.cookies.get(AT)?.value
    const invitationMode = sessionBearer.length > 0

    // Signed-in visitors cannot start Invitation registration (any bearer source).
    if (invitationMode && accessToken) {
      const denied = NextResponse.json(
        { error: SIGNED_IN_MESSAGE },
        { status: 403 },
      )
      clearRegistrationSessionCookie(denied, RS)
      return denied
    }

    // Prefer session bearer over any caller-supplied email (Invitation mode).
    const payload = invitationMode
      ? { sessionBearer }
      : typeof body["email"] === "string"
        ? { email: body["email"] }
        : body

    const response = await fetch(
      `${issuerUrl}/oauth/passkey/register-options`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    )

    const data = await response.json()

    if (!response.ok) {
      const nextResponse = NextResponse.json(data, { status: response.status })
      // Drop a stale Registration Session so open registration or a fresh link
      // exchange is not stuck behind an invalid cookie until maxAge.
      if (invitationMode) {
        clearRegistrationSessionCookie(nextResponse, RS)
      }
      return nextResponse
    }

    return NextResponse.json(data)
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error"
    console.error("Passkey register options error:", {
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
    })
    return NextResponse.json(
      { error: "Failed to generate registration options. Please try again." },
      { status: 500 },
    )
  }
}
