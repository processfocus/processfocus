/**
 * OAuth Authorization Server Metadata endpoint handler.
 * GET /.well-known/oauth-authorization-server
 * @packageDocumentation
 */
import { HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Effect } from "effect"
import { getIssuerUrl } from "../request"
import { json } from "../response"
import { ProviderRegistryService } from "../services/provider-registry"
import type { MissingHostError, OAuthEndpointError } from "./errors"

/**
 * OAuth Authorization Server Metadata response per RFC 8414.
 */
export interface DiscoveryResponse {
  readonly issuer: string
  readonly authorization_endpoint: string
  readonly token_endpoint: string
  readonly jwks_uri: string
  readonly response_types_supported: readonly string[]
  readonly token_endpoint_auth_methods_supported: readonly string[]
  readonly code_challenge_methods_supported: readonly string[]
  readonly grant_types_supported: readonly string[]
  readonly providers_supported: readonly string[]
  /**
   * When true, the login UI may offer Passkey Open Registration. When false or
   * omitted, self-registration is hidden (invite-only / Registration Link).
   */
  readonly passkey_open_registration?: boolean
}

/**
 * Cache headers for discovery response.
 * Browsers cache for 1 hour, CDN caches for 24 hours.
 */
const CACHE_HEADERS = {
  "Cache-Control": "public, max-age=3600, s-maxage=86400",
}

/**
 * Handle GET /.well-known/oauth-authorization-server
 * Returns OAuth Authorization Server Metadata per RFC 8414.
 *
 * Results are cached by CDN (s-maxage=86400) and browsers (max-age=3600).
 */
export const handleDiscovery: Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  MissingHostError | OAuthEndpointError,
  ProviderRegistryService | HttpServerRequest.HttpServerRequest
> = Effect.gen(function* () {
  const providerRegistry = yield* ProviderRegistryService
  const request = yield* HttpServerRequest.HttpServerRequest

  // Construct the issuer URL from the request headers
  const iss = yield* getIssuerUrl(request.headers)

  // Get all providers (static + dynamic)
  const allProviders = yield* providerRegistry.listProviders
  const passkeyOpenRegistration = allProviders.includes("passkey")
    ? yield* providerRegistry.isPasskeyOpenRegistration
    : false

  const response: DiscoveryResponse = {
    issuer: iss,
    authorization_endpoint: `${iss}/oauth/authorize`,
    token_endpoint: `${iss}/oauth/token`,
    jwks_uri: `${iss}/.well-known/jwks.json`,
    response_types_supported: ["code"],
    token_endpoint_auth_methods_supported: [
      "client_secret_basic",
      "client_secret_post",
      "none",
    ],
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: [
      "authorization_code",
      "refresh_token",
      "client_credentials",
    ],
    providers_supported: [...allProviders],
    passkey_open_registration: passkeyOpenRegistration,
  }

  return yield* json(response).pipe(
    Effect.map((r) => HttpServerResponse.setHeaders(r, CACHE_HEADERS)),
  )
})
