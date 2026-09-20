import { type NextRequest, NextResponse } from "next/server"
import { getIssuerUrl } from "@/lib/auth/client"
import { getCookieNamesFromHost } from "@/lib/auth/session"

/**
 * Public copy for every invalid Registration Link / Session state.
 * Must not disclose whether the link expired, was revoked, or never existed.
 */
export const INVITATION_REGISTRATION_INVALID_MESSAGE =
  "This registration link is no longer valid. Ask an administrator for a new Registration Link."

/**
 * Exchanges a Registration Link fragment token for a ten-minute Registration
 * Session cookie. Same-origin POST only; raw token never lands in query/path.
 *
 * @route POST /api/auth/passkey/registration-session
 */
export const POST = async (request: NextRequest) => {
  try {
    const host = request.headers.get("host") ?? ""
    const { accessToken: AT, registrationSession: RS } =
      getCookieNamesFromHost(host)

    // Signed-in visitors cannot start Invitation registration.
    if (request.cookies.get(AT)?.value) {
      return NextResponse.json(
        {
          error: "signed_in",
          message:
            "Sign out before using a Registration Link to create a passkey.",
        },
        {
          status: 403,
          headers: {
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
          },
        },
      )
    }

    const body = (await request.json().catch(() => null)) as {
      token?: unknown
    } | null
    const token = typeof body?.token === "string" ? body.token.trim() : ""
    if (!token) {
      return NextResponse.json(
        { error: INVITATION_REGISTRATION_INVALID_MESSAGE },
        {
          status: 400,
          headers: {
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
          },
        },
      )
    }

    const issuerUrl = getIssuerUrl()
    const response = await fetch(
      `${issuerUrl}/oauth/passkey/registration-session-exchange`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      },
    )

    const data = (await response.json().catch(() => ({}))) as {
      email?: string
      sessionBearer?: string
      expiresAt?: string
      error?: string
    }

    if (!response.ok || !data.sessionBearer || !data.email) {
      return NextResponse.json(
        {
          error: data.error ?? INVITATION_REGISTRATION_INVALID_MESSAGE,
        },
        {
          status: response.ok ? 400 : response.status,
          headers: {
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
          },
        },
      )
    }

    const nextResponse = NextResponse.json(
      { email: data.email, expiresAt: data.expiresAt },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      },
    )

    // HttpOnly host-only path-restricted Registration Session cookie.
    nextResponse.cookies.set(RS, data.sessionBearer, {
      httpOnly: true,
      secure: process.env["NODE_ENV"] === "production",
      sameSite: "strict",
      maxAge: 600, // ten minutes
      path: "/api/auth/passkey",
    })

    return nextResponse
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error"
    console.error("Registration session exchange error:", {
      error: errorMessage,
    })
    return NextResponse.json(
      { error: INVITATION_REGISTRATION_INVALID_MESSAGE },
      {
        status: 500,
        headers: {
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      },
    )
  }
}
