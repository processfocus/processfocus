/**
 * OAuth endpoint handlers as Effect functions.
 *
 * Each endpoint returns an Effect that yields HttpServerResponse directly.
 * The issuer.ts file provides the context and mounts them to HttpRouter.
 *
 * @packageDocumentation
 */

// Internal helpers (for use by issuer.ts)
export {
  type ClientAuthResult,
  authenticateClient,
  buildInvalidClientResponse,
} from "./_internal/client-authentication"
export {
  type GenerateTokensInput,
  type GenerateTokensOptions,
  type GeneratedTokens,
  generateTokens,
} from "./_internal/token-generation"
// Endpoint handlers
export { handleAuthorize } from "./authorize"
export { type DiscoveryResponse, handleDiscovery } from "./discovery"
// Errors
export {
  ClientAuthError,
  InvalidAccessTokenError,
  InvalidAuthorizationCodeError,
  InvalidRefreshTokenError,
  MissingHostError,
  MissingParameterError,
  OAuthEndpointError,
  type OAuthErrorCode,
  PKCEValidationError,
  UnauthorizedClientError,
  UnknownStateError,
} from "./errors"
export { type JwksKey, type JwksResponse, handleJwks } from "./jwks"
export { type RevokeResponse, handleRevoke } from "./revoke"
// Token endpoint
export {
  type TokenEndpointResult,
  handleAuthorizationCodeGrant,
  handleClientCredentialsGrant,
  handleRefreshTokenGrant,
  handleToken,
} from "./token"
// Types
export type {
  AllowCallbackInput,
  AuthorizationState,
  ClientAuthenticationMethod,
  NormalizedClient,
  OnRefreshScopeInput,
  OnRefreshScopeResult,
  OnSuccessResponder,
  TokenTtl,
} from "./types"
export { type UserinfoResponse, handleUserinfo } from "./userinfo"
