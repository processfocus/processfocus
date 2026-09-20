/**
 * Effect TaggedErrors for OAuth endpoint operations.
 * @packageDocumentation
 */
import { Data } from "effect"

/**
 * OAuth error codes as defined by RFC 6749.
 */
export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_grant"
  | "unauthorized_client"
  | "invalid_client"
  | "access_denied"
  | "unsupported_grant_type"
  | "server_error"
  | "temporarily_unavailable"
  | "invalid_scope"
  | "invalid_redirect_uri"
  | "invalid_token"

/**
 * Base OAuth error for endpoint operations.
 * Used when an OAuth-compliant error response is needed.
 */
export class OAuthEndpointError extends Data.TaggedError(
  "@pf/openauth/OAuthEndpointError",
)<{
  readonly error: OAuthErrorCode
  readonly description: string
  readonly statusCode: number
}> {}

/**
 * Client authentication failed.
 * Per RFC 6749, returns 401 with WWW-Authenticate header.
 */
export class ClientAuthError extends Data.TaggedError(
  "@pf/openauth/ClientAuthError",
)<{
  readonly description: string
}> {}

/**
 * Missing required parameter in request.
 */
export class MissingParameterError extends Data.TaggedError(
  "@pf/openauth/MissingParameterError",
)<{
  readonly parameter: string
}> {
  get description(): string {
    return `Missing parameter: ${this.parameter}`
  }
}

/**
 * Client is not authorized for the requested operation.
 */
export class UnauthorizedClientError extends Data.TaggedError(
  "@pf/openauth/UnauthorizedClientError",
)<{
  readonly clientID: string
  readonly redirectURI: string
}> {
  get description(): string {
    return `Client ${this.clientID} is not authorised to use this redirect_uri: ${this.redirectURI}`
  }
}

/**
 * Browser state is unknown or cookies expired.
 */
export class UnknownStateError extends Data.TaggedError(
  "@pf/openauth/UnknownStateError",
)<{}> {
  get description(): string {
    return "The browser was in an unknown state. This could be because certain cookies expired or the browser was switched in the middle of an authentication flow."
  }
}

/**
 * Invalid or expired authorization code.
 */
export class InvalidAuthorizationCodeError extends Data.TaggedError(
  "@pf/openauth/InvalidAuthorizationCodeError",
)<{}> {
  get description(): string {
    return "Authorization code has been used or expired"
  }
}

/**
 * Invalid or expired refresh token.
 */
export class InvalidRefreshTokenError extends Data.TaggedError(
  "@pf/openauth/InvalidRefreshTokenError",
)<{}> {
  get description(): string {
    return "Refresh token has been used or expired"
  }
}

/**
 * Invalid or expired access token.
 */
export class InvalidAccessTokenError extends Data.TaggedError(
  "@pf/openauth/InvalidAccessTokenError",
)<{}> {
  get description(): string {
    return "Invalid access token"
  }
}

/**
 * PKCE validation failed.
 */
export class PKCEValidationError extends Data.TaggedError(
  "@pf/openauth/PKCEValidationError",
)<{
  readonly reason: "missing_verifier" | "invalid_verifier" | "required_for_public_client"
}> {
  get description(): string {
    switch (this.reason) {
      case "missing_verifier":
        return "Missing code_verifier"
      case "invalid_verifier":
        return "Code verifier does not match"
      case "required_for_public_client":
        return "PKCE is required for this client"
      default: {
        const _exhaustive: never = this.reason
        return _exhaustive
      }
    }
  }
}

/**
 * Missing host header in request.
 * Cannot determine request origin without host or x-forwarded-host header.
 */
export class MissingHostError extends Data.TaggedError(
  "@pf/openauth/MissingHostError",
)<{}> {
  get description(): string {
    return "Missing host or x-forwarded-host header in request"
  }
}

/**
 * JWT verification failed (signature, issuer, audience, expiry, etc.).
 */
export class JwtVerificationError extends Data.TaggedError(
  "@pf/openauth/JwtVerificationError",
)<{
  readonly message: string
  readonly cause: unknown
}> {}

/**
 * An internal invariant was violated (programming error / impossible state).
 */
export class InvariantViolationError extends Data.TaggedError(
  "@pf/openauth/InvariantViolationError",
)<{
  readonly message: string
}> {}
