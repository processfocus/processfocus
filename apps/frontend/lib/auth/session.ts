import { Data, Effect } from "effect"
import { io } from "next/cache"
import { cookies, headers } from "next/headers"
import { type Session, subjects } from "@pf/auth-session"
import { getAuthClient } from "./client"
import {
  DEFAULT_ACCESS_TOKEN_MAX_AGE,
  DEFAULT_REFRESH_TOKEN_MAX_AGE,
} from "./config"
import { decodeJwtPayload } from "./jwt"
import { acceptVerifiedSession } from "./ssr-session"

/**
 * Compute port-suffixed cookie names when running on localhost.
 * This prevents cookie collisions between multiple local runtime instances
 * running on different ports (e.g. localhost:3000 and localhost:3001).
 */
export async function getCookieNames() {
  const h = await headers()
  const host = h.get("host") ?? ""
  return getCookieNamesFromHost(host)
}

/**
 * Sync variant for use in proxy.ts / login route where the host string is already available.
 */
export function getCookieNamesFromHost(host: string) {
  let suffix = ""

  if (host) {
    try {
      const url = new URL(`http://${host}`)
      if (
        (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
        url.port
      ) {
        suffix = `_${url.port}`
      }
    } catch {
      suffix = ""
    }
  }

  return {
    accessToken: `access_token${suffix}`,
    refreshToken: `refresh_token${suffix}`,
    oauthState: `oauth_state${suffix}`,
    passkeyAuthCookies: `passkey_auth_cookies${suffix}`,
    /**
     * Registration Session bearer from a Registration Link exchange.
     * Path-restricted to passkey registration endpoints.
     */
    registrationSession: `registration_session${suffix}`,
  }
}

type CookieNames = Awaited<ReturnType<typeof getCookieNames>>

/**
 * Hide JWT tokens from JavaScript, unless we are using AppSync Events websockets.
 *
 * For AppSync we must surface our cookies, as we need access to the
 * JWT token in order to send the proper websocket authentication.
 *
 * @returns true if access token should be exposed to JavaScript, false otherwise
 */
const shouldExposeAccessTokenToJavaScript = (): boolean => {
  return !!process.env["APPSYNC_EVENTS_HTTP_HOST"]
}

/**
 * Error when no access token is found in cookies
 */
class NoAccessTokenError extends Data.TaggedError("NoAccessTokenError")<{
  message: string
}> {}

/**
 * Error when JWT verification fails
 */
class JWTVerificationError extends Data.TaggedError("JWTVerificationError")<{
  message: string
}> {}

type SessionWithToken = Session & {
  accessToken: string
}

export type SessionWithTokenAndExpiry = Session & {
  accessToken: string
  /** Unix timestamp in seconds when the access token expires */
  expiresAt: number
}

/**
 * Get the current session with access token and expiry time.
 * Used by the root layout when it needs both the token (for API calls)
 * and expiry (for client-side refresh scheduling).
 *
 * Returns session + accessToken + expiresAt or null if not authenticated.
 */
export const getSessionWithTokenAndExpiry =
  async (): Promise<SessionWithTokenAndExpiry | null> => {
    const cookieStore = await cookies()
    const { accessToken: AT } = await getCookieNames()
    const accessToken = cookieStore.get(AT)?.value

    if (!accessToken) {
      return null
    }

    // Partial prerenders can already have cookies. Keep the client-cache clock
    // and live session verification outside prerendering without caching results.
    await io()
    const authClient = getAuthClient()
    const verified = await authClient.verify(subjects, accessToken, undefined)

    if (verified.err) {
      return null
    }
    const session = await acceptVerifiedSession(
      verified.subject.properties,
      accessToken,
    )
    if (!session) return null

    // Decode JWT to get expiry time
    const payload = decodeJwtPayload(accessToken)
    if (!payload?.exp) {
      return null
    }

    return {
      ...session,
      accessToken,
      expiresAt: payload.exp,
    }
  }

/**
 * Get the current session with access token
 * Only use this from server-side code (Server Components, API routes, Server Actions)
 * that needs to make authenticated API calls with Authorization headers
 *
 * The token is cryptographically verified against the (cached) issuer
 * key. Delegated sessions additionally require live issuer facts on every call.
 * We do not refresh the token if it is expired.
 *
 * For client-side code, use getSession() and rely on httpOnly cookies
 *
 * Returns an Effect that must be run with Effect.runPromise or provided in a layer.
 * Error types: NoAccessTokenError | ConfigError | JWTVerificationError | ParseError
 */
export const getSessionWithToken = Effect.gen(function* () {
  const cookieStore = yield* Effect.promise(() => cookies())
  const { accessToken: AT } = yield* Effect.promise(() => getCookieNames())
  const accessToken = cookieStore.get(AT)?.value

  if (!accessToken) {
    return yield* Effect.fail(
      new NoAccessTokenError({ message: "No access token found in cookies" }),
    )
  }

  // Match the async session entry point: cookies alone are not an IO boundary
  // when Next.js resumes a partial prerender with request data.
  yield* Effect.promise(() => io())
  const authClient = getAuthClient()
  const verified = yield* Effect.tryPromise({
    try: () => authClient.verify(subjects, accessToken, undefined),
    catch: (error) =>
      new JWTVerificationError({
        message: error instanceof Error ? error.message : String(error),
      }),
  })

  if (verified.err) {
    return yield* Effect.fail(
      new JWTVerificationError({
        message: "Session is unavailable or invalid",
      }),
    )
  }
  const session = yield* Effect.promise(() =>
    acceptVerifiedSession(verified.subject.properties, accessToken),
  )
  if (!session)
    return yield* new JWTVerificationError({
      message: "Session is unavailable or invalid",
    })

  return {
    ...session,
    accessToken: accessToken,
  } satisfies SessionWithToken
})

/**
 * Cookie options for access token.
 */
export const getAccessTokenCookieOptions = (maxAge: number) => ({
  httpOnly: !shouldExposeAccessTokenToJavaScript(),
  secure: process.env["NODE_ENV"] === "production",
  sameSite: "lax" as const,
  maxAge,
})

/**
 * Cookie options for refresh token.
 */
export const getRefreshTokenCookieOptions = (maxAge: number) => ({
  httpOnly: true,
  secure: process.env["NODE_ENV"] === "production",
  sameSite: "lax" as const,
  maxAge,
})

/**
 * Set session cookies with tokens.
 * Used by oauth callback, refresh route, and proxy middleware.
 */
export const setTokenCookies = async (
  cookieStore: Awaited<ReturnType<typeof cookies>>,
  tokens: {
    access: string
    refresh?: string
    expiresIn?: number
    refreshExpiresIn?: number
  },
  cookieNames?: CookieNames,
) => {
  const { accessToken: AT, refreshToken: RT } =
    cookieNames ?? (await getCookieNames())

  cookieStore.set(
    AT,
    tokens.access,
    getAccessTokenCookieOptions(
      tokens.expiresIn ?? DEFAULT_ACCESS_TOKEN_MAX_AGE,
    ),
  )

  if (tokens.refresh) {
    cookieStore.set(
      RT,
      tokens.refresh,
      getRefreshTokenCookieOptions(
        tokens.refreshExpiresIn ?? DEFAULT_REFRESH_TOKEN_MAX_AGE,
      ),
    )
  }
}

/**
 * Set session cookies with tokens.
 *
 * This is the place where we set cookies for the first time (after oauth login).
 */
export const setSessionCookies = async (tokens: {
  access: string
  refresh?: string
  expiresIn?: number
  refreshExpiresIn?: number
}) => {
  const cookieStore = await cookies()
  await setTokenCookies(cookieStore, tokens)
}

/**
 * Clear session cookies
 */
export const clearSession = async () => {
  const cookieStore = await cookies()
  const { accessToken: AT, refreshToken: RT } = await getCookieNames()
  cookieStore.delete(AT)
  cookieStore.delete(RT)
}
