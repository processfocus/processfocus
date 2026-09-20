/**
 * Shared types and context for endpoint Effect functions.
 * @packageDocumentation
 */
import type {
  HttpBody,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform"
import type { Effect } from "effect"
import type {
  KeyManagementService,
  NoSigningKeysError,
} from "../services/key-management"
import type { StorageError, StorageService } from "../storage/storage"
import type { InvariantViolationError, MissingHostError, OAuthEndpointError } from "./errors"

/**
 * Authentication method used by OAuth clients at the token endpoint.
 */
export type ClientAuthenticationMethod =
  | "client_secret_basic"
  | "client_secret_post"
  | "client_jwt"
  | "none"

/**
 * Normalized client configuration after validation and processing.
 */
export interface NormalizedClient {
  readonly id: string
  readonly redirectUris: readonly string[]
  readonly corsOrigins: readonly string[]
  /** Argon2id hash of the client secret. Only present for confidential clients. */
  readonly secretHash: string | undefined
  readonly enforcedAuthMethod: ClientAuthenticationMethod | undefined
  readonly isPublic: boolean
  /** The audience claim for tokens issued to this client. Defaults to client ID. */
  readonly audience: string
}

/**
 * Stored authorization state during OAuth flow.
 */
export interface AuthorizationState {
  readonly redirect_uri: string
  readonly response_type: string
  readonly state: string | undefined
  readonly client_id: string
  readonly audience: string | undefined
  readonly pkce:
    | {
        readonly challenge: string
        readonly method: "S256"
      }
    | undefined
}

/**
 * Input for the onRefreshScope callback.
 */
export interface OnRefreshScopeInput {
  /** User ID from the current token subject */
  readonly userId: string
  /** ID of the client requesting the refresh */
  readonly clientId: string
  /** Raw scope parameter from the refresh request */
  readonly scope: string
  /** Current token properties that would be refreshed */
  readonly currentProperties: Record<string, unknown>
}

/**
 * Result from the onRefreshScope callback.
 */
export interface OnRefreshScopeResult {
  /** Updated token properties */
  readonly properties: Record<string, unknown>
  /** Optional access token TTL override in seconds */
  readonly accessTokenTtl?: number
}

/**
 * Input for the allow callback.
 */
export interface AllowCallbackInput {
  readonly clientID: string
  readonly redirectURI: string
  /** The requested audience for the access token. If not provided, defaults to clientID. */
  readonly audience: string | undefined
}

/**
 * Token TTL configuration.
 */
export interface TokenTtl {
  readonly access: number
  readonly refresh: number
  readonly refreshReuse: number
  readonly refreshRetention: number
}

/**
 * Responder interface for the success callback.
 *
 * The `subject` method may require KeyManagementService when generating tokens
 * directly (e.g., in client_credentials flow). For authorization code flow,
 * only StorageService and HttpServerRequest are needed.
 */
export interface OnSuccessResponder {
  subject(
    type: string,
    properties: unknown,
    opts?: {
      readonly ttl?: {
        readonly access?: number
        readonly refresh?: number
      }
      readonly subject?: string
    },
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    | HttpBody.HttpBodyError
    | StorageError
    | MissingHostError
    | OAuthEndpointError
    | NoSigningKeysError
    | InvariantViolationError,
    StorageService | HttpServerRequest.HttpServerRequest | KeyManagementService
  >
  error(
    error:
      | "invalid_request"
      | "invalid_grant"
      | "unauthorized_client"
      | "invalid_client"
      | "access_denied"
      | "unsupported_grant_type"
      | "server_error"
      | "temporarily_unavailable",
    description: string,
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    StorageError,
    StorageService
  >
}
