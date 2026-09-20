/**
 * JWKS endpoint handler.
 * GET /.well-known/jwks.json
 * @packageDocumentation
 */
import { HttpServerResponse } from "@effect/platform"
import { Effect } from "effect"
import type { JWK } from "jose"
import { json } from "../response"
import { KeyManagementService } from "../services/key-management"
import type { StorageError } from "../storage/storage"

/**
 * JWKS key with additional fields.
 */
export interface JwksKey extends JWK {
  readonly alg: string
  readonly exp?: number | undefined
}

/**
 * JWKS response structure.
 */
export interface JwksResponse {
  readonly keys: readonly JwksKey[]
}

/**
 * Cache headers for JWKS response.
 * Browsers cache for 1 hour, CDN caches for 24 hours.
 */
const CACHE_HEADERS = {
  "Cache-Control": "public, max-age=3600, s-maxage=86400",
}

/**
 * Handle GET /.well-known/jwks.json
 * Returns the JSON Web Key Set containing public signing keys.
 *
 * Keys are cached by CDN (s-maxage=86400) and browsers (max-age=3600).
 */
export const handleJwks: Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  StorageError,
  KeyManagementService
> = Effect.gen(function* () {
  const keyMgmt = yield* KeyManagementService
  const allKeys = yield* keyMgmt.allSigningKeys

  const response: JwksResponse = {
    keys: allKeys.map((item) => ({
      ...item.jwk,
      alg: item.alg,
      exp: item.expired
        ? Math.floor(item.expired.getTime() / 1000)
        : undefined,
    })),
  }

  return yield* json(response).pipe(
    Effect.map((r) => HttpServerResponse.setHeaders(r, CACHE_HEADERS)),
  )
})
