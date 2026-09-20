/**
 * Token endpoint dispatcher.
 * POST /oauth/token
 * @packageDocumentation
 */
import type { HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Effect } from "effect"
import { errorJson } from "../../response"
import type { IssuerCallbacks } from "../../services/callbacks"
import type { ClientRegistryService } from "../../services/client-registry"
import type { TokenTtlConfig } from "../../services/config"
import type { CookieAuthService } from "../../services/cookie-auth"
import type {
  KeyManagementService,
  NoSigningKeysError,
} from "../../services/key-management"
import type { ProviderRegistryService } from "../../services/provider-registry"
import type { StorageError, StorageService } from "../../storage/storage"
import type { InvariantViolationError, MissingHostError, OAuthEndpointError } from "../errors"
import { handleAuthorizationCodeGrant } from "./authorization-code"
import {
  type ClientCredentialsResult,
  handleClientCredentialsGrant,
} from "./client-credentials"
import { handleRefreshTokenGrant } from "./refresh-token"

export { handleAuthorizationCodeGrant } from "./authorization-code"
export { handleClientCredentialsGrant } from "./client-credentials"
export { handleRefreshTokenGrant } from "./refresh-token"

/**
 * Result of token endpoint processing.
 * Either a complete HttpServerResponse or an indication that additional processing is needed.
 */
export type TokenEndpointResult =
  | HttpServerResponse.HttpServerResponse
  | {
      readonly type: "client_credentials_direct"
      readonly scope: string | undefined
      readonly clientId: string
      readonly clientAudience: string
    }
  | {
      readonly type: "client_credentials_upstream"
      readonly provider: string
      readonly clientId: string
      readonly clientAudience: string
    }

/**
 * Handle POST /oauth/token
 * Dispatches to the appropriate grant type handler.
 */
export const handleToken = (
  form: Map<string, string>,
): Effect.Effect<
  TokenEndpointResult,
  | StorageError
  | MissingHostError
  | OAuthEndpointError
  | NoSigningKeysError
  | InvariantViolationError,
  | ClientRegistryService
  | KeyManagementService
  | TokenTtlConfig
  | CookieAuthService
  | IssuerCallbacks
  | ProviderRegistryService
  | HttpServerRequest.HttpServerRequest
  | StorageService
> =>
  Effect.gen(function* () {
    const grantType = form.get("grant_type")

    if (grantType === "authorization_code") {
      return yield* handleAuthorizationCodeGrant(form)
    }

    if (grantType === "refresh_token") {
      return yield* handleRefreshTokenGrant(form)
    }

    if (grantType === "client_credentials") {
      const result: ClientCredentialsResult =
        yield* handleClientCredentialsGrant(form)

      // If we got an HttpServerResponse (error), return it
      if ("status" in result) {
        return result as HttpServerResponse.HttpServerResponse
      }

      if ("needsSuccessCallback" in result) {
        return {
          type: "client_credentials_direct" as const,
          scope: result.scope,
          clientId: result.clientId,
          clientAudience: result.clientAudience,
        }
      }

      if ("needsUpstreamProvider" in result) {
        return {
          type: "client_credentials_upstream" as const,
          provider: result.provider,
          clientId: result.clientId,
          clientAudience: result.clientAudience,
        }
      }

      // Should not reach here
      return result
    }

    return yield* errorJson("unsupported_grant_type", "Invalid grant_type", 400)
  })
