import { timingSafeEqual } from "node:crypto"
import { Effect } from "effect"
import { type NextRequest, NextResponse } from "next/server"
import {
  Application,
  AuthorizationService,
  ProviderUserPrincipal,
} from "@pf/auth-policy"
import { subjects } from "@pf/auth-session"
import { OAuthMetadataFetchError } from "@pf/openauth/error"
import {
  getDummyBypassUserForAuthCallback,
  getLoginErrorForAuthCallback,
} from "@/lib/auth/callback-error"
import { getAuthClient } from "@/lib/auth/client"
import { readReauthenticationState } from "@/lib/auth/reauthentication-state"
import { validateRedirect } from "@/lib/auth/redirect"
import { getCookieNamesFromHost, setSessionCookies } from "@/lib/auth/session"
import { admitsNewSession } from "@/lib/auth/session-admission"
import { environmentUnavailableMessage } from "@/lib/auth/session-admission-message"
import { runEffect } from "@/lib/effect/run-effect"
import { CedarAuthorizationLayer } from "@/lib/effect/services"

/**
 * Constant-time string comparison to prevent timing attacks
 * Used for comparing security-sensitive values like CSRF tokens
 */
const constantTimeEqual = (a: string, b: string): boolean => {
  // Length check can fail fast - different lengths reveal no information
  if (a.length !== b.length) return false
  // Use constant-time comparison for actual content
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

export const GET = async (request: NextRequest) => {
  const searchParams = request.nextUrl.searchParams
  const code = searchParams.get("code")
  const error = searchParams.get("error")
  const errorDescription = searchParams.get("error_description")
  const returnedState = searchParams.get("state")

  if (error || !code) {
    console.error({
      message: "Authentication failed",
      error,
      errorDescription,
      code,
    })
    const loginError = getLoginErrorForAuthCallback(error)
    const loginUrl = new URL("/login", request.url)
    loginUrl.searchParams.set("error", loginError)
    const dummyBypassUser = getDummyBypassUserForAuthCallback(
      error,
      errorDescription,
    )
    if (dummyBypassUser) {
      loginUrl.searchParams.set("dummy_bypass_user", dummyBypassUser)
    }
    return NextResponse.redirect(loginUrl)
  }

  // CSRF Protection: Validate state parameter
  const { oauthState: OS } = getCookieNamesFromHost(
    request.headers.get("host") ?? "",
  )
  const stateCookie = request.cookies.get(OS)?.value
  const reauthentication = readReauthenticationState(stateCookie)
  const storedState = reauthentication?.state ?? stateCookie

  if (
    !returnedState ||
    !storedState ||
    !constantTimeEqual(returnedState, storedState)
  ) {
    console.warn({
      message: "OAuth state mismatch - possible CSRF attack",
      returnedState: returnedState ? "[present]" : "[missing]",
      storedState: storedState ? "[present]" : "[missing]",
      matches:
        returnedState && storedState
          ? constantTimeEqual(returnedState, storedState)
          : false,
    })
    return NextResponse.redirect(
      new URL("/login?error=invalid_state", request.url),
    )
  }

  // Build the redirect URI exactly as it was during authorization
  // Must include query params (like ?redirect=...) for OAuth exchange to match
  const url = new URL(request.url)
  const callbackUrl = new URL(`${url.protocol}//${url.host}/api/auth/callback`)
  const redirectParam = searchParams.get("redirect")
  if (redirectParam) {
    callbackUrl.searchParams.set("redirect", redirectParam)
  }
  const redirectURI = callbackUrl.toString()

  const authClient = getAuthClient()
  const exchanged = await authClient.exchange(code, redirectURI)

  if (exchanged.err) {
    console.error({
      message: "Exchange failed",
      exchanged,
    })
    return NextResponse.redirect(
      new URL("/login?error=exchange_failed", request.url),
    )
  }

  try {
    // Verify the access token to extract session data
    const verified = await authClient.verify(
      subjects,
      exchanged.tokens.access,
      undefined,
    )

    if (verified.err) {
      console.error({
        message: "Token verification failed after exchange",
        error: verified.err,
        errorName: verified.err.constructor.name,
        errorMessage:
          verified.err instanceof Error
            ? verified.err.message
            : String(verified.err),
        metadataUrl:
          verified.err instanceof OAuthMetadataFetchError
            ? verified.err.url
            : undefined,
      })
      return NextResponse.redirect(
        new URL("/login?error=verification_failed", request.url),
      )
    }

    const session = verified.subject.properties
    if ("delegation" in session) {
      return NextResponse.redirect(
        new URL("/login?error=not_authorized", request.url),
      )
    }

    if (reauthentication !== null) {
      const prior = await authClient.verify(
        subjects,
        reauthentication.accessToken,
        undefined,
      )
      if (
        prior.err ||
        "delegation" in prior.subject.properties ||
        prior.subject.properties.userId !== session.userId ||
        !("humanAuthentication" in session) ||
        session.humanAuthentication?.providerUserId !== session.userId ||
        session.humanAuthentication.method !== "passkey"
      ) {
        const response = NextResponse.json(
          {
            error:
              "Verify with the same account's passkey. Your token was not changed.",
          },
          { status: 403 },
        )
        response.cookies.delete({ name: OS, path: "/api/auth/callback" })
        return response
      }
    }

    // Check authorization using Cedar policies
    const isProviderUser = "email" in session
    const allowLogin = Effect.gen(function* () {
      const auth = yield* AuthorizationService

      // Create principal from session data
      // For provider users, use email as identifier; for M2M users, use userId
      const principal = new ProviderUserPrincipal(
        isProviderUser ? session.email : session.userId,
        {
          roles: session.roles ?? [],
          orgUnitId: isProviderUser ? session.orgUnitId : "",
        },
      )

      // Check if user can login to frontend application
      const canLogin = yield* auth.canLogin(
        principal,
        new Application("frontend"),
      )

      return canLogin
    })

    // Run the authorization check using shared Cedar layer
    // (policies may already be cached from login page preload)
    const authResult = await runEffect(
      Effect.provide(allowLogin, CedarAuthorizationLayer),
    ).catch((error) => {
      console.error({
        message: "Authorization check failed",
        error,
      })
      return false
    })

    if (!authResult) {
      console.warn({
        message: "User denied access - no roles assigned",
        userId: session.userId,
        email: isProviderUser ? session.email : undefined,
        roles: session.roles,
      })
      return NextResponse.redirect(
        new URL("/login?error=not_authorized", request.url),
      )
    }

    if (!(await admitsNewSession())) {
      if (request.headers.get("accept") === "application/json")
        return NextResponse.json(
          {
            error: "environment_unavailable",
            message: environmentUnavailableMessage,
          },
          { status: 503, headers: { "cache-control": "no-store" } },
        )
      return NextResponse.redirect(
        new URL("/login?error=environment_unavailable", request.url),
      )
    }

    await setSessionCookies(exchanged.tokens)

    // Get redirect URL from query params (passed through OAuth flow)
    // redirectParam was already extracted above for OAuth exchange
    const { url: redirect, rejected, reason } = validateRedirect(redirectParam)

    if (rejected) {
      console.warn({
        message: "Redirect URL rejected",
        redirectParam,
        reason,
        userId: session.userId,
      })
    }

    // Clear the OAuth state cookie after successful validation
    const response =
      reauthentication !== null &&
      request.headers.get("accept") === "application/json"
        ? NextResponse.json(
            { success: true },
            { headers: { "cache-control": "no-store" } },
          )
        : NextResponse.redirect(new URL(redirect, request.url))
    response.cookies.delete({
      name: OS,
      path: "/api/auth/callback",
    })

    return response
  } catch (error) {
    console.error({
      message: "Token verification threw after exchange",
      error,
      errorName: error instanceof Error ? error.name : undefined,
      errorMessage: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.redirect(
      new URL("/login?error=verification_failed", request.url),
    )
  }
}
