/**
 * Request helper utilities for working with HttpServerRequest.
 *
 * @packageDocumentation
 */

import type { HttpServerRequest } from "@effect/platform"
import { Effect } from "effect"
import { MissingHostError, OAuthEndpointError } from "./endpoints/errors"

/**
 * Headers object type for request header extraction.
 */
type Headers = Readonly<Record<string, string | undefined>>

/**
 * Extract host from request headers.
 *
 * Priority order (for reverse proxy / Lambda / CloudFront scenarios):
 * 1. x-forwarded-host (set by reverse proxy with original client-facing host)
 * 2. host (direct request host)
 *
 * @param headers - Request headers object
 * @returns The host, or undefined if neither header is present
 */
export const getHost = (headers: Headers): string | undefined =>
  headers["x-forwarded-host"] ?? headers["host"]

/**
 * Extract protocol from request headers.
 *
 * @param headers - Request headers object
 * Trust CloudFront's viewer protocol before the proxy hop's protocol:
 * Lambda Web Adapter preserves headers but forwards to the app over HTTP.
 * Proxies must overwrite these headers; direct callers are not trusted proxies.
 * Missing headers mean local HTTP. Invalid values must not downgrade to HTTP.
 */
export const getProtocol = (headers: Headers): "http" | "https" | undefined => {
  const protocol =
    headers["cloudfront-forwarded-proto"] ??
    headers["x-forwarded-proto"] ??
    "http"
  return protocol === "http" || protocol === "https" ? protocol : undefined
}

/**
 * Extract issuer URL from request headers.
 *
 * Priority order (for reverse proxy / Lambda / CloudFront scenarios):
 * 1. x-forwarded-host (set by reverse proxy with original client-facing host)
 * 2. host (direct request host)
 *
 * Protocol is determined by getProtocol (defaults to local HTTP).
 * Fails with MissingHostError if neither host nor x-forwarded-host header is present.
 *
 * @param headers - Request headers object
 * @returns Effect with the issuer URL (e.g., "https://example.com")
 */
export const getIssuerUrl = (
  headers: Headers,
): Effect.Effect<string, MissingHostError | OAuthEndpointError> => {
  const host = getHost(headers)
  if (!host) {
    return Effect.fail(new MissingHostError())
  }
  const protocol = getProtocol(headers)
  if (!protocol) {
    return Effect.fail(new OAuthEndpointError({
      error: "invalid_request",
      description: "Invalid forwarded protocol header",
      statusCode: 400,
    }))
  }
  return Effect.succeed(`${protocol}://${host}`)
}

/**
 * Get relative URL from current request.
 * Uses x-original-path header if set (for lazy-loaded providers where URL was rewritten).
 *
 * Fails with MissingHostError if neither host nor x-forwarded-host header is present.
 */
export const getRelativeUrl = (
  request: HttpServerRequest.HttpServerRequest,
  path: string,
): Effect.Effect<string, MissingHostError | OAuthEndpointError> =>
  Effect.gen(function* () {
    const url = new URL(request.url, "http://localhost")
    const origin = yield* getIssuerUrl(request.headers)
    // Use x-original-path if set (for lazy-loaded providers where URL was rewritten)
    const originalPath = request.headers["x-original-path"]
    const pathname =
      typeof originalPath === "string" ? originalPath : url.pathname
    const base = origin + pathname.replace(/\/[^/]*$/, "")
    return `${base}/${path.replace(/^\.\//, "")}`
  })
