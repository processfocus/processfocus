/**
 * Error classes shared by the promise-based OpenAuth client and older endpoint helpers.
 *
 * Endpoint-focused OAuth errors in this module are legacy; prefer the Effect-based
 * errors from `@pf/openauth/endpoints/errors` for server-side endpoint code.
 *
 * The client-facing result errors in this module remain part of the supported API.
 *
 * @packageDocumentation
 */

export const OAUTH_INVALID_CLIENT_ERROR = "invalid_client"

/**
 * The OAuth server returned an error.
 * @deprecated Use `OAuthEndpointError` from `@pf/openauth/endpoints/errors` instead.
 */
export class OauthError extends Error {
  constructor(
    public error:
      | "invalid_request"
      | "invalid_grant"
      | "unauthorized_client"
      | typeof OAUTH_INVALID_CLIENT_ERROR
      | "access_denied"
      | "unsupported_grant_type"
      | "server_error"
      | "temporarily_unavailable",
    public description: string,
  ) {
    super(`${error} - ${description}`)
  }
}

/**
 * The `provider` needs to be passed in.
 * @deprecated Use `MissingParameterError` from `@pf/openauth/endpoints/errors` instead.
 */
export class MissingProviderError extends OauthError {
  constructor() {
    super(
      "invalid_request",
      "Must specify `provider` query parameter if `select` callback on issuer is not specified",
    )
  }
}

/**
 * The given parameter is missing.
 * @deprecated Use `MissingParameterError` from `@pf/openauth/endpoints/errors` instead.
 */
export class MissingParameterError extends OauthError {
  constructor(public parameter: string) {
    super("invalid_request", `Missing parameter: ${parameter}`)
  }
}

/**
 * The given client is not authorised to use the redirect URI that was passed in.
 * @deprecated Use `UnauthorizedClientError` from `@pf/openauth/endpoints/errors` instead.
 */
export class UnauthorizedClientError extends OauthError {
  constructor(
    public clientID: string,
    redirectURI: string,
  ) {
    super(
      "unauthorized_client",
      `Client ${clientID} is not authorised to use this redirect_uri: ${redirectURI}`,
    )
  }
}

/**
 * The browser was in an unknown state.
 *
 * This can happen when certain cookies have expired. Or the browser was switched in the middle
 * of the authentication flow.
 * @deprecated Use `UnknownStateError` from `@pf/openauth/endpoints/errors` instead.
 */
export class UnknownStateError extends Error {
  constructor() {
    super(
      "The browser was in an unknown state. This could be because certain cookies expired or the browser was switched in the middle of an authentication flow.",
    )
  }
}

/**
 * The given subject is invalid.
 */
export class InvalidSubjectError extends Error {
  constructor() {
    super("Invalid subject")
  }
}

/**
 * The given refresh token is invalid.
 */
export class InvalidRefreshTokenError extends Error {
  constructor() {
    super("Invalid refresh token")
  }
}

/**
 * The given access token is invalid.
 */
export class InvalidAccessTokenError extends Error {
  constructor() {
    super("Invalid access token")
  }
}

/**
 * The given authorization code is invalid.
 */
export class InvalidAuthorizationCodeError extends Error {
  constructor(
    description?: string,
    public readonly code?: string,
  ) {
    super(description ?? "Invalid authorization code")
  }
}

/**
 * Failed to fetch OAuth discovery or JWKS metadata needed by the client.
 */
export class OAuthMetadataFetchError extends Error {
  constructor(
    public readonly url: string,
    message: string,
    cause?: unknown,
  ) {
    super(`Failed to fetch OAuth metadata from ${url}: ${message}`, { cause })
    this.name = "OAuthMetadataFetchError"
  }
}
