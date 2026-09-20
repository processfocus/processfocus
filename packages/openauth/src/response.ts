/**
 * Response helper utilities for creating HttpServerResponse instances.
 *
 * These helpers handle serialization errors internally, always succeeding
 * with an HttpServerResponse (falling back to 500 on serialization failure).
 *
 * @packageDocumentation
 */

import { HttpServerResponse } from "@effect/platform"
import { Effect } from "effect"

/**
 * Create a JSON response, handling serialization errors internally.
 *
 * If JSON serialization fails (e.g., due to BigInt or circular references),
 * returns a 500 Internal Server Error response instead of propagating the error.
 *
 * @param data - The data to serialize as JSON
 * @param options - Optional response options (status, headers, etc.)
 * @returns Effect that always succeeds with an HttpServerResponse
 */
export const json = <T>(
  data: T,
  options?: HttpServerResponse.Options.WithContentType,
) =>
  HttpServerResponse.json(data, options).pipe(
    Effect.catchAll(() =>
      Effect.succeed(
        HttpServerResponse.text("Internal Server Error", { status: 500 }),
      ),
    ),
  )

/**
 * Create a JSON response for sensitive token payloads.
 *
 * OAuth token responses must not be cached by browsers or intermediaries.
 */
export const noStoreJson = <T>(
  data: T,
  options?: HttpServerResponse.Options.WithContentType,
) =>
  json(data, {
    ...options,
    headers: {
      ...options?.headers,
      "Cache-Control": "no-store",
      Pragma: "no-cache",
    },
  })

/**
 * Create a JSON error response with standard OAuth error format.
 *
 * @param error - The OAuth error code (e.g., "invalid_request")
 * @param description - Human-readable error description
 * @param status - HTTP status code
 * @returns Effect that always succeeds with an HttpServerResponse
 */
export const errorJson = (
  error: string,
  description: string,
  status: number,
) => json({ error, error_description: description }, { status })
