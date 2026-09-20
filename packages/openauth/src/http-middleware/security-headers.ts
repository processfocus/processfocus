/**
 * Security headers middleware using Effect HttpMiddleware.
 *
 * Applies security headers to all responses:
 * - X-Content-Type-Options: nosniff
 * - Referrer-Policy: no-referrer
 * - X-Frame-Options: DENY
 * - Content-Security-Policy: restrictive default policy
 *
 * @packageDocumentation
 */

import { HttpMiddleware, HttpServerResponse } from "@effect/platform"
import { Effect } from "effect"

/**
 * Default security headers applied to all responses.
 */
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'none'; frame-ancestors 'none'; sandbox",
}

/**
 * Security headers middleware.
 * Applies security headers to all responses.
 *
 * Does not override existing headers if already set by the handler.
 */
export const securityHeaders = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const response = yield* app

    // Build headers, not overriding existing ones
    const headersToSet: Record<string, string> = {}
    const responseHeaders = response.headers

    if (!responseHeaders["x-content-type-options"]) {
      headersToSet["X-Content-Type-Options"] =
        SECURITY_HEADERS["X-Content-Type-Options"]
    }
    if (!responseHeaders["referrer-policy"]) {
      headersToSet["Referrer-Policy"] = SECURITY_HEADERS["Referrer-Policy"]
    }
    if (!responseHeaders["x-frame-options"]) {
      headersToSet["X-Frame-Options"] = SECURITY_HEADERS["X-Frame-Options"]
    }
    if (!responseHeaders["content-security-policy"]) {
      headersToSet["Content-Security-Policy"] =
        SECURITY_HEADERS["Content-Security-Policy"]
    }

    return HttpServerResponse.setHeaders(response, headersToSet)
  }),
)

/**
 * Apply security headers to a response.
 * This is useful for applying headers to responses created outside the middleware.
 */
export const applySecurityHeaders = (
  response: HttpServerResponse.HttpServerResponse,
) => {
  const headersToSet: Record<string, string> = {}
  const responseHeaders = response.headers

  if (!responseHeaders["x-content-type-options"]) {
    headersToSet["X-Content-Type-Options"] =
      SECURITY_HEADERS["X-Content-Type-Options"]
  }
  if (!responseHeaders["referrer-policy"]) {
    headersToSet["Referrer-Policy"] = SECURITY_HEADERS["Referrer-Policy"]
  }
  if (!responseHeaders["x-frame-options"]) {
    headersToSet["X-Frame-Options"] = SECURITY_HEADERS["X-Frame-Options"]
  }
  if (!responseHeaders["content-security-policy"]) {
    headersToSet["Content-Security-Policy"] =
      SECURITY_HEADERS["Content-Security-Policy"]
  }

  return HttpServerResponse.setHeaders(response, headersToSet)
}
