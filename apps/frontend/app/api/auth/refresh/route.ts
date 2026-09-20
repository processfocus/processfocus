import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { subjects } from "@pf/auth-session"
import { getRealtimeRecipientId } from "@pf/auth-session/realtime-recipient"
import { getAuthClient } from "@/lib/auth/client"
import { decodeJwtPayload } from "@/lib/auth/jwt"
import { matchesRealtimeSessionToken } from "@/lib/auth/realtime-session-token"
import { getCookieNames, setTokenCookies } from "@/lib/auth/session"
import { getSessionCacheScope } from "@/lib/auth/session-cache-scope"
import { acceptVerifiedSession } from "@/lib/auth/ssr-session"

interface RefreshSuccessResponse {
  success: true
  /** Unix timestamp in seconds when the access token expires */
  expiresAt: number
  cacheScope: string
  recipientId: string
}

interface RefreshFailureResponse {
  success: false
  redirect: string
}

type RefreshResponse = RefreshSuccessResponse | RefreshFailureResponse

/**
 * POST /api/auth/refresh
 *
 * Proactively refreshes the access token using the refresh token stored in httpOnly cookies.
 * This endpoint is called by the client-side TokenRefreshScheduler before the
 * access token expires.
 *
 * Unlike verify() which only refreshes on expiry, this endpoint always requests
 * new tokens to support proactive refresh before expiration.
 *
 * Returns:
 * - { success: true, expiresAt: number } on successful refresh
 * - { success: false, redirect: "/login" } when refresh fails (requires re-login)
 */
export async function POST(
  request: Request,
): Promise<NextResponse<RefreshResponse>> {
  const respond = (body: RefreshResponse, status = 200) =>
    NextResponse.json(body, {
      status,
      headers: {
        "Cache-Control": "no-store",
      },
    })
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return respond({ success: false, redirect: "/login" }, 403)
  }
  const cookieStore = await cookies()
  const names = await getCookieNames()
  const refreshToken = cookieStore.get(names.refreshToken)?.value

  if (!refreshToken) {
    return respond({ success: false, redirect: "/login" })
  }

  const authClient = getAuthClient()

  // Call refresh() directly to always get new tokens
  // (verify() only refreshes when token is expired, but we want proactive refresh)
  const result = await authClient.refresh(refreshToken)

  if (result.err || !result.tokens) {
    // Refresh failed - clear cookies and instruct client to redirect to login
    cookieStore.delete(names.accessToken)
    cookieStore.delete(names.refreshToken)
    return respond({ success: false, redirect: "/login" })
  }

  const verified = await authClient.verify(
    subjects,
    result.tokens.access,
    undefined,
  )
  if (verified.err) {
    cookieStore.delete(names.accessToken)
    cookieStore.delete(names.refreshToken)
    return respond({ success: false, redirect: "/login" })
  }
  const session = await acceptVerifiedSession(
    verified.subject.properties,
    result.tokens.access,
  )
  const expiresAt = decodeJwtPayload(result.tokens.access)?.exp
  if (
    !session ||
    expiresAt === undefined ||
    !matchesRealtimeSessionToken(result.tokens.access, session, expiresAt)
  ) {
    cookieStore.delete(names.accessToken)
    cookieStore.delete(names.refreshToken)
    return respond({ success: false, redirect: "/login" })
  }
  const recipientId = await getRealtimeRecipientId(session, expiresAt)
  if (!recipientId) {
    cookieStore.delete(names.accessToken)
    cookieStore.delete(names.refreshToken)
    return respond({ success: false, redirect: "/login" })
  }

  // Set new tokens as cookies
  await setTokenCookies(cookieStore, {
    access: result.tokens.access,
    refresh: result.tokens.refresh,
    expiresIn: result.tokens.expiresIn,
    ...(result.tokens.refreshExpiresIn !== undefined && {
      refreshExpiresIn: result.tokens.refreshExpiresIn,
    }),
  })

  return respond({
    success: true,
    expiresAt,
    cacheScope: getSessionCacheScope(session),
    recipientId,
  })
}
