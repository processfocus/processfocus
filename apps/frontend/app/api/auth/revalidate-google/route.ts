import { type NextRequest, NextResponse } from "next/server"
import { getAuthClient } from "@/lib/auth/client"
import {
  expiredGoogleIdentity,
  googleRevalidationAttemptMaxAge,
  isDocumentNavigation,
  sealGoogleAttempt,
} from "@/lib/auth/google-revalidation"
import { getValidRedirect } from "@/lib/auth/redirect"
import {
  getCookieNamesFromHost,
  getRefreshTokenCookieOptions,
} from "@/lib/auth/session"

export async function GET(request: NextRequest): Promise<NextResponse> {
  const destination = getValidRedirect(
    request.nextUrl.searchParams.get("redirect"),
  )
  const login = new URL("/login", request.url)
  login.searchParams.set("redirect", destination)
  const headers = {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  }
  if (!isDocumentNavigation(request))
    return new NextResponse(null, { status: 400, headers })

  const names = getCookieNamesFromHost(request.headers.get("host") ?? "")
  const prior = expiredGoogleIdentity(
    request.cookies.get(names.googleRevalidation)?.value,
  )
  if (!prior) return NextResponse.redirect(login, { headers })

  let response: NextResponse
  try {
    const callback = new URL("/api/auth/callback", request.url)
    const { url, challenge } = await getAuthClient().authorize(
      callback.toString(),
      "code",
      {
        pkce: false,
        provider: "google",
        googleRevalidationSubject: prior.subject,
      },
    )
    response = NextResponse.redirect(url, { headers })
    response.cookies.set(
      names.oauthState,
      sealGoogleAttempt({
        subject: prior.subject,
        state: challenge.state,
        destination,
      }),
      {
        ...getRefreshTokenCookieOptions(googleRevalidationAttemptMaxAge),
        path: callback.pathname,
      },
    )
  } catch {
    login.searchParams.set("error", "auth_failed")
    response = NextResponse.redirect(login, { headers })
  }
  // Consume the hint before leaving PF, so an error or Back cannot start a loop.
  response.cookies.delete(names.googleRevalidation)
  response.cookies.delete(names.accessToken)
  response.cookies.delete(names.refreshToken)
  return response
}
