/**
 * Shared authentication configuration constants.
 */

/** Default access token TTL in seconds (1 hour) */
export const DEFAULT_ACCESS_TOKEN_MAX_AGE = 60 * 60

/** Default refresh token TTL in seconds (90 days) */
export const DEFAULT_REFRESH_TOKEN_MAX_AGE = 90 * 24 * 60 * 60

/**
 * How many seconds before token expiry to trigger a refresh.
 * Used by the client-side TokenRefreshScheduler.
 */
export const REFRESH_BUFFER_SECONDS = 5 * 60

/**
 * URL path prefixes that do not require authentication.
 * Used by proxy.ts and related tests to identify public routes.
 */
const PUBLIC_PATH_PREFIXES = [
  "/login",
  // Invitation passkey bootstrap: Registration Link page is unauthenticated.
  // The bearer lives in the URI fragment and is exchanged for a short-lived
  // Registration Session cookie; no user session is required or created here.
  "/register/passkey",
  "/embed",
  // Everything under /public is intentionally unauthenticated. Route handlers
  // must validate their own capability tokens before exposing data or mutation.
  "/public",
  "/api/auth",
  "/api/embed",
  // Public API routes are browser-callable without a user session; keep them
  // token/capability-scoped and avoid returning sensitive backend details.
  "/api/public",
  "/_pf/app-icons",
  "/_pf/public-form-branding",
  // Browser boot health surface: unauthenticated and data-free; it boots the
  // organisation frontend plugin composition and reports a ready marker. It
  // must never expose organisation data or require a user session.
  "/_pf/health",
  "/manifest.webmanifest",
  "/processfocus-embed.js",
]

/** Check whether a pathname matches a public (unauthenticated) route. */
export const isPublicPath = (pathname: string) =>
  PUBLIC_PATH_PREFIXES.some((p) => pathname.startsWith(p))
