import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"
import { subjects } from "@pf/auth-session"
import { getAuthClient } from "@/lib/auth/client"
import { DEFAULT_REFRESH_TOKEN_MAX_AGE, isPublicPath } from "@/lib/auth/config"
import { getValidRedirect } from "@/lib/auth/redirect"
import {
  getAccessTokenCookieOptions,
  getCookieNamesFromHost,
  getRefreshTokenCookieOptions,
} from "@/lib/auth/session"
import { acceptVerifiedSession } from "@/lib/auth/ssr-session"

/** Paths that should not preserve redirect after login */
const noRedirectPaths = ["/", "/login", "/logout"]

/**
 * Create a login redirect response.
 * For RSC requests, we need to strip the _rsc query param to force a full page
 * navigation that will re-evaluate the layout and remove the AppShell.
 * Includes the original path as `redirect` param so user returns after login.
 */
function createLoginRedirect(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl
  const loginUrl = new URL("/login", request.url)

  // Strip all query params to ensure clean redirect
  loginUrl.search = ""

  // Add redirect param unless it's a path we shouldn't redirect back to
  // Check pathname only (query params on /login don't affect this check)
  // Include query string in redirect to preserve filters, etc. (e.g. /to-dos?filter=urgent)
  if (!noRedirectPaths.includes(pathname)) {
    const redirectPath = search ? `${pathname}${search}` : pathname
    loginUrl.searchParams.set("redirect", redirectPath)
  }

  if (request.method === "POST" && request.headers.has("next-action")) {
    // Next's action client consumes this header. A Location redirect is followed
    // by fetch instead, leaving the authenticated page and its stale data visible.
    return new NextResponse(null, {
      status: 303,
      headers: { "x-action-redirect": `${loginUrl};replace` },
    })
  }
  return NextResponse.redirect(loginUrl)
}

export const proxy = async (request: NextRequest) => {
  const { pathname } = request.nextUrl

  // Propagate pathname to the root layout via request header so it can
  // distinguish public pages (e.g. /login) from protected ones. The root
  // layout conditionally wraps children in providers (GraphqlClientProvider,
  // AuthProvider, etc.) only when a session exists. Without this header it
  // has no way to know the current route, so when a session expires between
  // proxy verification and layout render it would render a protected page
  // without providers — crashing client components that depend on them.
  // With the header the layout can redirect to /login instead.
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set("x-pathname", pathname)

  // This protected handler owns verification and live validity checks so stale
  // sessions can finish the CLI callback rather than strand it at /login.
  if (pathname === "/cli-auth") {
    return NextResponse.next({ request: { headers: requestHeaders } })
  }

  // Resolve cookie names first. Public routes should not require auth-client
  // initialization unless we actually need to verify or refresh a session.
  const host = request.headers.get("host") ?? ""
  const { accessToken: AT, refreshToken: RT } = getCookieNamesFromHost(host)

  // Allow public paths
  if (isPublicPath(pathname)) {
    // Redirect already-authenticated users away from /login
    if (pathname === "/login") {
      const accessToken = request.cookies.get(AT)?.value
      const refreshToken = request.cookies.get(RT)?.value

      if (accessToken || refreshToken) {
        try {
          const authClient = getAuthClient()

          if (accessToken) {
            const verified = await authClient.verify(
              subjects,
              accessToken,
              undefined,
            )
            if (
              !verified.err &&
              (await acceptVerifiedSession(
                verified.subject.properties,
                accessToken,
              ))
            ) {
              const redirectTo = getValidRedirect(
                request.nextUrl.searchParams.get("redirect"),
              )
              return NextResponse.redirect(new URL(redirectTo, request.url))
            }
          } else if (refreshToken) {
            // AT cookie expired but RT still valid — refresh and redirect
            const refreshed = await authClient.refresh(refreshToken)
            if (!refreshed.err && refreshed.tokens) {
              const checked = await authClient.verify(
                subjects,
                refreshed.tokens.access,
                undefined,
              )
              if (
                checked.err ||
                !(await acceptVerifiedSession(
                  checked.subject.properties,
                  refreshed.tokens.access,
                ))
              ) {
                const response = NextResponse.next({
                  request: { headers: requestHeaders },
                })
                response.cookies.delete(AT)
                response.cookies.delete(RT)
                return response
              }
              const redirectTo = getValidRedirect(
                request.nextUrl.searchParams.get("redirect"),
              )
              const response = NextResponse.redirect(
                new URL(redirectTo, request.url),
              )
              response.cookies.set(
                AT,
                refreshed.tokens.access,
                getAccessTokenCookieOptions(refreshed.tokens.expiresIn),
              )
              response.cookies.set(
                RT,
                refreshed.tokens.refresh,
                getRefreshTokenCookieOptions(
                  refreshed.tokens.refreshExpiresIn ??
                    DEFAULT_REFRESH_TOKEN_MAX_AGE,
                ),
              )
              return response
            }
          }
        } catch (error) {
          console.error(
            "[proxy] Auth client initialization failed for /login; allowing public page render",
            error,
          )
        }
      }
    }
    return NextResponse.next({ request: { headers: requestHeaders } })
  }

  // Check session
  const accessToken = request.cookies.get(AT)?.value
  const refreshToken = request.cookies.get(RT)?.value

  if (!accessToken && !refreshToken) {
    console.log("[proxy] No tokens, redirecting to /login", { pathname })
    return createLoginRedirect(request)
  }

  const authClient = getAuthClient()

  // Case 1: No access token but have refresh token
  // This happens when the access token cookie expired (Max-Age reached) but the
  // refresh token is still valid. The browser automatically removes expired cookies,
  // so we won't receive the access token even though the refresh token is still present.
  // We attempt to get new tokens using the refresh token.
  if (!accessToken && refreshToken) {
    console.log("[proxy] Access token expired, attempting refresh", {
      pathname,
    })
    const refreshed = await authClient.refresh(refreshToken)

    if (refreshed.err || !refreshed.tokens) {
      console.log("[proxy] Refresh failed, redirecting to /login", {
        pathname,
        error: refreshed.err,
      })
      const response = createLoginRedirect(request)
      response.cookies.delete(AT)
      response.cookies.delete(RT)
      return response
    }

    const checked = await authClient.verify(
      subjects,
      refreshed.tokens.access,
      undefined,
    )
    if (
      checked.err ||
      !(await acceptVerifiedSession(
        checked.subject.properties,
        refreshed.tokens.access,
      ))
    ) {
      const response = createLoginRedirect(request)
      response.cookies.delete(AT)
      response.cookies.delete(RT)
      return response
    }

    // Refresh succeeded - set new cookies and continue
    console.log("[proxy] Refresh succeeded, setting new cookies", { pathname })
    const response = NextResponse.next({ request: { headers: requestHeaders } })
    response.cookies.set(
      AT,
      refreshed.tokens.access,
      getAccessTokenCookieOptions(refreshed.tokens.expiresIn),
    )
    response.cookies.set(
      RT,
      refreshed.tokens.refresh,
      getRefreshTokenCookieOptions(
        refreshed.tokens.refreshExpiresIn ?? DEFAULT_REFRESH_TOKEN_MAX_AGE,
      ),
    )
    return response
  }

  // Case 2: Have access token - verify it (will auto-refresh if JWT expired)
  const verified = await authClient.verify(
    subjects,
    accessToken,
    refreshToken ? { refresh: refreshToken } : undefined,
  )

  if (
    verified.err ||
    !(await acceptVerifiedSession(
      verified.subject.properties,
      verified.tokens?.access ?? accessToken ?? "",
    ))
  ) {
    // Token invalid and couldn't refresh
    console.error("[proxy] Token verification FAILED, redirecting to /login", {
      error: verified.err,
      errorName: verified.err?.constructor?.name,
      errorMessage:
        verified.err instanceof Error
          ? verified.err.message
          : String(verified.err),
      pathname,
      hadRefreshToken: !!refreshToken,
    })
    const response = createLoginRedirect(request)
    response.cookies.delete(AT)
    response.cookies.delete(RT)
    return response
  }

  // If tokens were refreshed, update cookies
  if (verified.tokens) {
    const response = NextResponse.next({ request: { headers: requestHeaders } })
    response.cookies.set(
      AT,
      verified.tokens.access,
      getAccessTokenCookieOptions(verified.tokens.expiresIn),
    )
    if (verified.tokens.refresh) {
      response.cookies.set(
        RT,
        verified.tokens.refresh,
        getRefreshTokenCookieOptions(
          verified.tokens.refreshExpiresIn ?? DEFAULT_REFRESH_TOKEN_MAX_AGE,
        ),
      )
    }
    return response
  }

  return NextResponse.next({ request: { headers: requestHeaders } })
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public files (public folder)
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|map)$).*)",
  ],
}
