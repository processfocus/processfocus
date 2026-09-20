/**
 * Token revocation endpoint handler.
 * POST /oauth/revoke
 * @packageDocumentation
 */
import type { HttpServerResponse } from "@effect/platform"
import { Effect } from "effect"
import { errorJson, json } from "../response"
import { Storage, type StorageError, type StorageService } from "../storage/storage"

/**
 * Revoke response per RFC 7009.
 */
export interface RevokeResponse {
  readonly success: boolean
}

/**
 * Handle POST /oauth/revoke
 * Revokes a refresh token per RFC 7009.
 *
 * Per RFC 7009 Section 2.2, returns 200 OK regardless of token validity.
 */
export const handleRevoke = (
  form: Map<string, string>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  StorageError,
  StorageService
> =>
  Effect.gen(function* () {
    const token = form.get("token")

    if (!token) {
      return yield* errorJson("invalid_request", "Missing token", 400)
    }

    // Parse refresh token to extract subject and token parts
    const splits = token.split(":")
    const tokenPart = splits.pop()
    const subject = splits.join(":")

    // Invalidate only the specific refresh token (RFC 7009)
    // Per RFC 7009 Section 2.2, return 200 OK regardless of token validity
    if (subject && tokenPart) {
      yield* Storage.remove(["oauth:refresh", subject, tokenPart])
    } else {
      yield* Effect.logDebug("Token revocation: malformed token format")
    }

    return yield* json({ success: true })
  })
