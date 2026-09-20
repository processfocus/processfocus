/**
 * CORS middleware using Effect HttpMiddleware.
 *
 * SECURITY NOTE: This implementation follows secure-by-default principles.
 * When no origin is specified, CORS headers are NOT set (same-origin only).
 * This prevents origin reflection vulnerabilities (CVE-2023-49803, CVE-2021-39185).
 *
 * Always explicitly specify the origin parameter:
 * - origin: "*" for public endpoints
 * - origin: "https://trusted.com" for specific domains
 * - origin: ["https://app1.com", "https://app2.com"] for whitelisting
 *
 * @packageDocumentation
 */

import {
  HttpMiddleware,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform"
import { Effect } from "effect"

/**
 * CORS configuration options.
 */
export interface CorsOptions {
  readonly origin?: string | readonly string[]
  readonly allowMethods?: readonly string[]
  readonly allowHeaders?: readonly string[]
  readonly exposeHeaders?: readonly string[]
  readonly credentials?: boolean
  readonly maxAge?: number
}

/**
 * Create CORS headers based on the request and options.
 */
const buildCorsHeaders = (
  requestOrigin: string | undefined,
  options: CorsOptions,
): Record<string, string> => {
  const headers: Record<string, string> = {}

  // Handle Origin header
  if (options.origin === "*") {
    headers["Access-Control-Allow-Origin"] = "*"
  } else if (typeof options.origin === "string") {
    headers["Access-Control-Allow-Origin"] = options.origin
  } else if (Array.isArray(options.origin) && requestOrigin) {
    if (options.origin.includes(requestOrigin)) {
      headers["Access-Control-Allow-Origin"] = requestOrigin
      headers["Vary"] = "Origin"
    }
  }

  // Handle Credentials
  if (options.credentials) {
    headers["Access-Control-Allow-Credentials"] = "true"
  }

  // Handle Allow-Methods
  if (options.allowMethods && options.allowMethods.length > 0) {
    headers["Access-Control-Allow-Methods"] = options.allowMethods.join(", ")
  }

  // Handle Allow-Headers
  if (options.allowHeaders && options.allowHeaders.length > 0) {
    headers["Access-Control-Allow-Headers"] = options.allowHeaders.join(", ")
  }

  // Handle Expose-Headers
  if (options.exposeHeaders && options.exposeHeaders.length > 0) {
    headers["Access-Control-Expose-Headers"] = options.exposeHeaders.join(", ")
  }

  // Handle Max-Age
  if (options.maxAge !== undefined) {
    headers["Access-Control-Max-Age"] = options.maxAge.toString()
  }

  return headers
}

/**
 * CORS middleware that handles preflight requests and adds CORS headers.
 */
export const cors = (options: CorsOptions = {}) =>
  HttpMiddleware.make((app) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const requestOrigin = request.headers["origin"]

      // Handle preflight request
      if (request.method === "OPTIONS") {
        const corsHeaders = buildCorsHeaders(requestOrigin, options)
        return HttpServerResponse.empty({ status: 204 }).pipe(
          HttpServerResponse.setHeaders(corsHeaders),
        )
      }

      // Handle actual request
      const response = yield* app
      const corsHeaders = buildCorsHeaders(requestOrigin, options)
      return HttpServerResponse.setHeaders(response, corsHeaders)
    }),
  )

/**
 * Apply CORS headers to a response without using middleware.
 */
export const applyCorsHeaders = (
  requestOrigin: string | undefined,
  response: HttpServerResponse.HttpServerResponse,
  options: CorsOptions = {},
): HttpServerResponse.HttpServerResponse => {
  const corsHeaders = buildCorsHeaders(requestOrigin, options)
  return HttpServerResponse.setHeaders(response, corsHeaders)
}
