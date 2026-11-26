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
import { googleSso, readGoogleAttempt } from "@/lib/auth/google-revalidation"
import { readReauthenticationState } from "@/lib/auth/reauthentication-state"
import { getValidRedirect, validateRedirect } from "@/lib/auth/redirect"
import { getCookieNamesFromHost, setSessionCookies } from "@/lib/auth/session"
import { admitsNewSession } from "@/lib/auth/session-admission"
import { environmentUnavailableMessage } from "@/lib/auth/session-admission-message"
import { runEffect } from "@/lib/effect/run-effect"
import { CedarAuthorizationLayer } from "@/lib/effect/services"
import { finishMcpLogin } from "@/lib/mcp/oauth"

/**
 * Constant-time string comparison to prevent timing attacks
 * Used for comparing security-sensitive values like CSRF tokens
 */
const constantTimeEqual = (a: string, b: string): boolean => {
  const first = Buffer.from(a)
  const second = Buffer.from(b)
  return first.length === second.length && timingSafeEqual(first, second)
}

export const GET = async (request: NextRequest) => {
  const searchParams = request.nextUrl.searchParams
  const code = searchParams.get("code")
  const error = searchParams.get("error")
  const errorDescription = searchParams.get("error_description")
  const returnedState = searchParams.get("state")
  const { oauthState: OS } = getCookieNamesFromHost(
    request.headers.get("host") ?? "",
  )
  const stateCookie = request.cookies.get(OS)?.value
  const googleAttempt = readGoogleAttempt(stateCookie)
  const reauthentication = readReauthenticationState(stateCookie)
  const storedState =
    googleAttempt === undefined
      ? (reauthentication?.state ?? stateCookie)
      : googleAttempt?.state
  const validState =
    returnedState &&
    storedState &&
    constantTimeEqual(returnedState, storedState)

  const returnToLogin = (loginError?: string) => {
    const loginUrl = new URL("/login", request.url)
    if (loginError) loginUrl.searchParams.set("error", loginError)
    if (googleAttempt) {
      loginUrl.searchParams.set(
        "redirect",
        getValidRedirect(googleAttempt.destination),
      )
    }
    const response = NextResponse.redirect(loginUrl)
    if (googleAttempt) {
      response.headers.set("cache-control", "no-store")
      response.cookies.delete({ name: OS, path: "/api/auth/callback" })
    }
    return response
  }

  if (error || !code) {
    if (googleAttempt) {
      if (!validState) return returnToLogin("invalid_state")
      return returnToLogin(
        error === "interaction_required" ? undefined : "auth_failed",
      )
    }
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
  if (!validState) {
    console.warn({
      message: "OAuth state mismatch - possible CSRF attack",
      returnedState: returnedState ? "[present]" : "[missing]",
      storedState: storedState ? "[present]" : "[missing]",
      matches: false,
    })
    return returnToLogin("invalid_state")
  }

  // Build the redirect URI exactly as it was during authorization
  // Must include query params (like ?redirect=...) for OAuth exchange to match
  const url = new URL(request.url)
  const callbackUrl = new URL(`${url.protocol}//${url.host}/api/auth/callback`)
  const redirectParam =
    googleAttempt?.destination ?? searchParams.get("redirect")
  if (redirectParam && !googleAttempt) {
    callbackUrl.searchParams.set("redirect", redirectParam)
  }
  const redirectURI = callbackUrl.toString()

  try {
    const authClient = getAuthClient()
    const exchanged = await authClient.exchange(code, redirectURI)
    if (exchanged.err) {
      console.error({ message: "Exchange failed", exchanged })
      return returnToLogin("exchange_failed")
    }
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
      return returnToLogin("verification_failed")
    }

    const session = verified.subject.properties
    if ("delegation" in session) return returnToLogin("not_authorized")
    // Independently bind the issued session to the signed Dashboard context.
    // Authorization request parameters alone are not identity evidence.
    if (googleAttempt && googleSso(session)?.subject !== googleAttempt.subject)
      return returnToLogin("auth_failed")

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
        userId: session.userId,
        email: isProviderUser ? session.email : undefined,
        roles: session.roles,
      })
      return undefined
    })

    if (authResult === false) {
      console.warn({
        message: "User denied access - no roles assigned",
        userId: session.userId,
        email: isProviderUser ? session.email : undefined,
        roles: session.roles,
      })
    }

    if (!authResult) {
      return returnToLogin("not_authorized")
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
      return returnToLogin("environment_unavailable")
    }

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

    const mcp =
      reauthentication === null && !googleAttempt
        ? await finishMcpLogin(request, redirect, exchanged.tokens)
        : undefined
    if (!mcp) await setSessionCookies(exchanged.tokens, session)

    // Clear the OAuth state cookie after successful validation
    const response =
      mcp ??
      (reauthentication !== null &&
      request.headers.get("accept") === "application/json"
        ? NextResponse.json(
            { success: true },
            { headers: { "cache-control": "no-store" } },
          )
        : NextResponse.redirect(new URL(redirect, request.url)))
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
    return returnToLogin("verification_failed")
  }
}
