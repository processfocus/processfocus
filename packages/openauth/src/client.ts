/**
 * Use the OpenAuth client kick off your OAuth flows, exchange tokens, refresh tokens,
 * and verify tokens.
 *
 * First, create a client.
 *
 * ```ts title="client.ts"
 * import { createClient } from "@openauthjs/openauth/client"
 *
 * const client = createClient({
 *   clientID: "my-client",
 *   issuer: "https://auth.myserver.com"
 * })
 * ```
 *
 * Kick off the OAuth flow by calling `authorize`.
 *
 * ```ts
 * const redirect_uri = "https://myserver.com/callback"
 *
 * const { url } = await client.authorize(
 *   redirect_uri,
 *   "code"
 * )
 * ```
 *
 * When the user completes the flow, `exchange` the code for tokens.
 *
 * ```ts
 * const tokens = await client.exchange(query.get("code"), redirect_uri)
 * ```
 *
 * And `verify` the tokens.
 *
 * ```ts
 * const verified = await client.verify(subjects, tokens.access)
 * ```
 *
 * @packageDocumentation
 */

import type { StandardSchemaV1 } from "@standard-schema/spec"
import { Either, Schema } from "effect"
import type { JSONWebKeySet } from "jose"
import {
  createLocalJWKSet,
  decodeJwt,
  errors,
  jwtVerify,
} from "jose"
import {
  InvalidAccessTokenError,
  InvalidAuthorizationCodeError,
  InvalidRefreshTokenError,
  InvalidSubjectError,
  OAuthMetadataFetchError,
} from "./error"
import { generatePKCE } from "./pkce"
import type { SubjectSchema } from "./subject"

/**
 * Schema for OAuth token endpoint response.
 * Validates required fields but allows additional properties.
 * @internal
 */
const TokenResponseSchema = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.Number,
  refresh_expires_in: Schema.optionalWith(Schema.Number, { exact: true }),
}).pipe(Schema.extend(Schema.Record({ key: Schema.String, value: Schema.Unknown })))

const OAuthErrorResponseSchema = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optionalWith(Schema.String, { exact: true }),
}).pipe(Schema.extend(Schema.Record({ key: Schema.String, value: Schema.Unknown })))

const tokenError = (
  json: unknown,
): { readonly code: string; readonly description?: string } | undefined => {
  const result = Schema.decodeUnknownEither(OAuthErrorResponseSchema)(json)
  if (Either.isLeft(result)) return undefined
  const code = result.right.error
  if (code === "") return undefined
  const description = result.right.error_description
  return description ? { code, description } : { code }
}

/**
 * The well-known information for an OAuth 2.0 authorization server.
 * @internal
 */
export interface WellKnown {
  /**
   * The URI to the JWKS endpoint.
   */
  jwks_uri: string
  /**
   * The URI to the token endpoint.
   */
  token_endpoint: string
  /**
   * The URI to the authorization endpoint.
   */
  authorization_endpoint: string
}

/**
 * The tokens returned by the auth server.
 */
export interface Tokens {
  /**
   * The access token.
   */
  access: string
  /**
   * The refresh token.
   */
  refresh: string

  /**
   * The number of seconds until the access token expires.
   */
  expiresIn: number

  /**
   * The number of seconds until the refresh token expires.
   * This is an extension to OAuth 2.1 (not part of the standard).
   */
  refreshExpiresIn?: number
}

interface ResponseLike {
  json(): Promise<unknown>
  ok: Response["ok"]
  status?: Response["status"]
}
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<ResponseLike>

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.length > 0) {
    return error.message
  }

  return String(error)
}

/**
 * The challenge that you can use to verify the code.
 */
export type Challenge = {
  /**
   * The state that was sent to the redirect URI.
   */
  state: string
  /**
   * The verifier that was sent to the redirect URI.
   */
  verifier?: string
}

/**
 * Configure the client.
 */
export interface ClientInput {
  /**
   * The client ID. This is just a string to identify your app.
   *
   * If you have a web app and a mobile app, you want to use different client IDs both.
   *
   * @example
   * ```ts
   * {
   *   clientID: "my-client"
   * }
   * ```
   */
  clientID?: string
  /**
   * The client secret for confidential clients.
   *
   * Only use this for server-side applications where the secret can be kept secure.
   * Do not use this for SPAs or mobile apps - use PKCE instead.
   *
   * @example
   * ```ts
   * {
   *   clientSecret: process.env.OAUTH_CLIENT_SECRET
   * }
   * ```
   */
  clientSecret?: string | undefined
  /**
   * Machine JWT for confidential server-side clients.
   *
   * When provided, the client uses `Authorization: Bearer <jwt>` for token
   * exchange and refresh calls instead of Basic auth.
   *
   * If `clientID`, `issuer`, or `audience` are omitted, they are inferred from
   * JWT claims:
   * - `properties.clientId` -> `clientID`
   * - `iss` -> `issuer`
   * - `aud` -> `audience`
   */
  jwt?: string | undefined
  /**
   * The URL of your OpenAuth server.
   *
   * @example
   * ```ts
   * {
   *   issuer: "https://auth.myserver.com"
   * }
   * ```
   */
  issuer?: string
  /**
   * The default audience for access tokens. This specifies which API/service the tokens
   * are intended for.
   *
   * This will be used as the default audience in all `authorize` calls unless overridden.
   *
   * @example
   * ```ts
   * {
   *   audience: "graphql-api"
   * }
   * ```
   */
  audience?: string
  /**
   * Optionally, override the internally used fetch function.
   *
   * This is useful if you are using a polyfilled fetch function in your application and you
   * want the client to use it too.
   */
  fetch?: FetchLike
}

export interface AuthorizeOptions {
  /**
   * Enable the PKCE flow. This is for SPA apps.
   *
   * ```ts
   * {
   *   pkce: true
   * }
   * ```
   *
   * @default false
   */
  pkce?: boolean | undefined
  /**
   * The provider you want to use for the OAuth flow.
   *
   * ```ts
   * {
   *   provider: "google"
   * }
   * ```
   *
   * If no provider is specified, the user is directed to a page where they can select from the
   * list of configured providers.
   *
   * If there's only one provider configured, the user will be redirected to that.
   */
  provider?: string | undefined
  /**
   * The audience for the access token. This specifies which API/service the token is intended for.
   *
   * ```ts
   * {
   *   audience: "graphql-api"
   * }
   * ```
   *
   * If not specified, the issuer will use the client's configured audience or fall back to the client ID.
   * Use this when the frontend needs tokens for a different service than itself.
   */
  audience?: string | undefined
}

export interface AuthorizeResult {
  /**
   * The challenge that you can use to verify the code. This is for the PKCE flow for SPA apps.
   *
   * This is an object that you _stringify_ and store it in session storage.
   *
   * ```ts
   * sessionStorage.setItem("challenge", JSON.stringify(challenge))
   * ```
   */
  challenge: Challenge
  /**
   * The URL to redirect the user to. This starts the OAuth flow.
   *
   * For example, for SPA apps.
   *
   * ```ts
   * location.href = url
   * ```
   */
  url: string
}

/**
 * Returned when the exchange is successful.
 */
export interface ExchangeSuccess {
  /**
   * This is always `false` when the exchange is successful.
   */
  err: false
  /**
   * The access and refresh tokens.
   */
  tokens: Tokens
}

/**
 * Returned when the exchange fails.
 */
export interface ExchangeError {
  /**
   * The type of error that occurred. You can handle this by checking the type.
   *
   * @example
   * ```ts
   * import { InvalidAuthorizationCodeError } from "@openauthjs/openauth/error"
   *
   * console.log(err instanceof InvalidAuthorizationCodeError)
   *```
   */
  err: InvalidAuthorizationCodeError
}

export interface RefreshOptions {
  /**
   * Optionally, pass in the access token.
   */
  access?: string
  /**
   * Optionally, pass a scope to request specific roles.
   * Format: "role:RolePath role:AnotherRolePath"
   */
  scope?: string
}

/**
 * Returned when the refresh is successful.
 */
export interface RefreshSuccess {
  /**
   * This is always `false` when the refresh is successful.
   */
  err: false
  /**
   * Returns the refreshed tokens only if they've been refreshed.
   *
   * If they are still valid, this will be `undefined`.
   */
  tokens?: Tokens
}

/**
 * Returned when the refresh fails.
 */
export interface RefreshError {
  /**
   * The type of error that occurred. You can handle this by checking the type.
   *
   * @example
   * ```ts
   * import { InvalidRefreshTokenError } from "@openauthjs/openauth/error"
   *
   * console.log(err instanceof InvalidRefreshTokenError)
   *```
   */
  err: InvalidRefreshTokenError | InvalidAccessTokenError
}

export interface VerifyOptions {
  /**
   * Optionally, pass in the refresh token.
   *
   * If passed in, this will automatically refresh the access token if it has expired.
   */
  refresh?: string
  /**
   * @internal
   */
  issuer?: string
  /**
   * @internal
   */
  audience?: string
  /**
   * Optionally, override the internally used fetch function.
   *
   * This is useful if you are using a polyfilled fetch function in your application and you
   * want the client to use it too.
   */
  fetch?: FetchLike
}

export interface VerifyResult<T extends SubjectSchema> {
  /**
   * This is always `undefined` when the verify is successful.
   */
  err?: undefined
  /**
   * Returns the refreshed tokens only if they’ve been refreshed.
   *
   * If they are still valid, this will be undefined.
   */
  tokens?: Tokens
  /**
   * @internal
   */
  aud: string
  /**
   * The decoded subjects from the access token.
   *
   * Has the same shape as the subjects you defined when creating the issuer.
   */
  subject: {
    [type in keyof T]: { type: type; properties: StandardSchemaV1.InferOutput<T[type]> }
  }[keyof T]
}

/**
 * Returned when the verify call fails.
 */
export interface VerifyError {
  /**
   * The type of error that occurred. You can handle this by checking the type.
   *
   * @example
   * ```ts
   * import { InvalidRefreshTokenError, OAuthMetadataFetchError } from "@openauthjs/openauth/error"
   *
   * console.log(err instanceof InvalidRefreshTokenError)
   * console.log(err instanceof OAuthMetadataFetchError)
   * ```
    */
  err:
    | InvalidRefreshTokenError
    | InvalidAccessTokenError
    | InvalidSubjectError
    | OAuthMetadataFetchError
}

/**
 * An instance of the OpenAuth client contains the following methods.
 */
export interface Client {
  /**
   * Start the autorization flow. For example, in SSR sites.
   *
   * ```ts
   * const { url } = await client.authorize(<redirect_uri>, "code")
   * ```
   *
   * This takes a redirect URI and the type of flow you want to use. The redirect URI is the
   * location where the user will be redirected to after the flow is complete.
   *
   * Supports both the _code_ and _token_ flows. We recommend using the _code_ flow as it's more
   * secure.
   *
   * :::tip
   * This returns a URL to redirect the user to. This starts the OAuth flow.
   * :::
   *
   * This returns a URL to the auth server. You can redirect the user to the URL to start the
   * OAuth flow.
   *
   * For SPA apps, we recommend using the PKCE flow.
   *
   * ```ts {4}
   * const { challenge, url } = await client.authorize(
   *   <redirect_uri>,
   *   "code",
   *   { pkce: true }
   * )
   * ```
   *
   * This returns a redirect URL and a challenge that you need to use later to verify the code.
   */
  authorize(
    redirectURI: string,
    response?: "code",
    opts?: AuthorizeOptions,
  ): Promise<AuthorizeResult>
  /**
   * Exchange the code for access and refresh tokens.
   *
   * ```ts
   * const exchanged = await client.exchange(<code>, <redirect_uri>)
   * ```
   *
   * You call this after the user has been redirected back to your app after the OAuth flow.
   *
   * :::tip
   * For SSR sites, the code is returned in the query parameter.
   * :::
   *
   * So the code comes from the query parameter in the redirect URI. The redirect URI here is
   * the one that you passed in to the `authorize` call when starting the flow.
   *
   * :::tip
   * For SPA sites, the code is returned through the URL hash.
   * :::
   *
   * If you used the PKCE flow for an SPA app, the code is returned as a part of the redirect URL
   * hash.
   *
   * ```ts {4}
   * const exchanged = await client.exchange(
   *   <code>,
   *   <redirect_uri>,
   *   <challenge.verifier>
   * )
   * ```
   *
   * You also need to pass in the previously stored challenge verifier.
   *
   * This method returns the access and refresh tokens. Or if it fails, it returns an error that
   * you can handle depending on the error.
   *
   * ```ts
   * import { InvalidAuthorizationCodeError } from "@openauthjs/openauth/error"
   *
   * if (exchanged.err) {
   *   if (exchanged.err instanceof InvalidAuthorizationCodeError) {
   *     // handle invalid code error
   *   }
   *   else {
   *     // handle other errors
   *   }
   * }
   *
   * const { access, refresh } = exchanged.tokens
   * ```
   */
  exchange(
    code: string,
    redirectURI: string,
    verifier?: string,
  ): Promise<ExchangeSuccess | ExchangeError>
  /**
   * Refreshes the tokens if they have expired. This is used in an SPA app to maintain the
   * session, without logging the user out.
   *
   * ```ts
   * const next = await client.refresh(<refresh_token>)
   * ```
   *
   * Can optionally take the access token as well. If passed in, this will skip the refresh
   * if the access token is still valid.
   *
   * ```ts
   * const next = await client.refresh(<refresh_token>, { access: <access_token> })
   * ```
   *
   * This returns the refreshed tokens only if they've been refreshed.
   *
   * ```ts
   * if (!next.err) {
   *   // tokens are still valid
   * }
   * if (next.tokens) {
   *   const { access, refresh } = next.tokens
   * }
   * ```
   *
   * Or if it fails, it returns an error that you can handle depending on the error.
   *
   * ```ts
   * import { InvalidRefreshTokenError } from "@openauthjs/openauth/error"
   *
   * if (next.err) {
   *   if (next.err instanceof InvalidRefreshTokenError) {
   *     // handle invalid refresh token error
   *   }
   *   else {
   *     // handle other errors
   *   }
   * }
   * ```
   */
  refresh(
    refresh: string,
    opts?: RefreshOptions,
  ): Promise<RefreshSuccess | RefreshError>
  /**
   * Verify the token in the incoming request.
   *
   * This is typically used for SSR sites where the token is stored in an HTTP only cookie. And
   * is passed to the server on every request.
   *
   * ```ts
   * const verified = await client.verify(<subjects>, <token>)
   * ```
   *
   * This takes the subjects that you had previously defined when creating the issuer.
   *
   * :::tip
   * If the refresh token is passed in, it'll automatically refresh the access token.
   * :::
   *
   * This can optionally take the refresh token as well. If passed in, it'll automatically
   * refresh the access token if it has expired.
   *
   * ```ts
   * const verified = await client.verify(<subjects>, <token>, { refresh: <refresh_token> })
   * ```
   *
   * This returns the decoded subjects from the access token. And the tokens if they've been
   * refreshed.
   *
   * ```ts
   * // based on the subjects you defined earlier
   * console.log(verified.subject.properties.userID)
   *
   * if (verified.tokens) {
   *   const { access, refresh } = verified.tokens
   * }
   * ```
   *
   * Or if it fails, it returns an error that you can handle depending on the error.
   *
   * ```ts
   * import { InvalidRefreshTokenError } from "@openauthjs/openauth/error"
   *
   * if (verified.err) {
   *   if (verified.err instanceof InvalidRefreshTokenError) {
   *     // handle invalid refresh token error
   *   }
   *   else {
   *     // handle other errors
   *   }
   * }
   * ```
   */
  verify<T extends SubjectSchema>(
    subjects: T,
    token: string,
    options?: VerifyOptions,
  ): Promise<VerifyResult<T> | VerifyError>
  /**
   * @deprecated use `authorize` instead, it will do pkce by default unless disabled with `opts.pkce = false`
   */
  pkce(
    redirectURI: string,
    opts?: {
      provider?: string
    },
  ): Promise<string[]>
  /**
   * Logout and invalidate all refresh tokens for the user.
   *
   * This calls the auth server to invalidate all refresh tokens associated with the
   * user's subject. After calling this, the refresh token will no longer be valid
   * for obtaining new access tokens.
   *
   * @param refresh - The refresh token to invalidate
   * @returns A promise resolving to an object indicating success or failure
   *
   * @example
   * ```ts
   * const result = await client.logout(refreshToken)
   * if (result.success) {
   *   // Clear local session/cookies
   * }
   * ```
   */
  logout(refresh: string): Promise<{ success: boolean }>
}

/**
 * Create an OpenAuth client.
 *
 * @param input - Configure the client.
 */
export function createClient(input: ClientInput): Client {
  const shouldDecodeJwt =
    !!input.jwt && (!input.clientID || !input.issuer || !input.audience)
  const decodedJwt = shouldDecodeJwt ? decodeJwt(input.jwt!) : undefined

  const jwtClientId =
    decodedJwt &&
    typeof decodedJwt === "object" &&
    "properties" in decodedJwt &&
    typeof decodedJwt["properties"] === "object" &&
    decodedJwt["properties"] !== null &&
    "clientId" in decodedJwt["properties"] &&
    typeof decodedJwt["properties"]["clientId"] === "string"
      ? decodedJwt["properties"]["clientId"]
      : undefined

  const jwtAudience =
    decodedJwt?.aud && typeof decodedJwt.aud === "string"
      ? decodedJwt.aud
      : Array.isArray(decodedJwt?.aud) && typeof decodedJwt.aud[0] === "string"
        ? decodedJwt.aud[0]
        : undefined

  const clientID = input.clientID ?? jwtClientId
  if (!clientID) throw new Error("No clientID")

  const issuer = input.issuer ?? decodedJwt?.iss ?? globalThis.process?.env?.["OPENAUTH_ISSUER"]
  if (!issuer) throw new Error("No issuer")

  const audience = input.audience ?? jwtAudience

  const jwksCache = new Map<string, ReturnType<typeof createLocalJWKSet>>()
  const issuerCache = new Map<string, WellKnown>()
  const f = input.fetch ?? fetch

  async function fetchJson<T>(url: string): Promise<T> {
    let response: ResponseLike
    try {
      response = await f(url)
    } catch (error) {
      throw new OAuthMetadataFetchError(url, getErrorMessage(error), error)
    }

    if (!response.ok) {
      const statusSuffix =
        typeof response.status === "number" ? ` (status ${response.status})` : ""
      throw new OAuthMetadataFetchError(
        url,
        `Unexpected response${statusSuffix}`,
      )
    }

    try {
      return (await response.json()) as T
    } catch (error) {
      throw new OAuthMetadataFetchError(
        url,
        `Invalid JSON response: ${getErrorMessage(error)}`,
        error,
      )
    }
  }

  async function getIssuer() {
    const cached = issuerCache.get(issuer!)
    if (cached) return cached
    const wellKnown = await fetchJson<WellKnown>(
      `${issuer}/.well-known/oauth-authorization-server`,
    )
    issuerCache.set(issuer!, wellKnown)
    return wellKnown
  }

  async function getJWKS() {
    const wk = await getIssuer()
    const cached = jwksCache.get(issuer!)
    if (cached) return cached
    const keyset = await fetchJson<JSONWebKeySet>(wk.jwks_uri)
    const result = createLocalJWKSet(keyset)
    jwksCache.set(issuer!, result)
    return result
  }

  const result = {
    async authorize(
      redirectURI: string,
      response = "code",
      opts?: AuthorizeOptions,
    ) {
      const result = new URL(`${issuer}/oauth/authorize`)
      const challenge: Challenge = {
        state: crypto.randomUUID(),
      }
      const shouldUsePkce = opts?.pkce ?? true
      result.searchParams.set("client_id", clientID)
      result.searchParams.set("redirect_uri", redirectURI)
      result.searchParams.set("response_type", response)
      result.searchParams.set("state", challenge.state)
      if (opts?.provider) result.searchParams.set("provider", opts.provider)
      const requestedAudience = opts?.audience ?? audience
      if (requestedAudience) result.searchParams.set("audience", requestedAudience)
      if (shouldUsePkce && response === "code") {
        const pkce = await generatePKCE()
        result.searchParams.set("code_challenge_method", "S256")
        result.searchParams.set("code_challenge", pkce.challenge)
        challenge.verifier = pkce.verifier
      }
      return {
        challenge,
        url: result.toString(),
      }
    },
    /**
     * @deprecated use `authorize` instead, it will do pkce by default unless disabled with `opts.pkce = false`
     */
    async pkce(
      redirectURI: string,
      opts?: {
        provider?: string
      },
    ) {
      const result = new URL(`${issuer}/oauth/authorize`)
      if (opts?.provider) result.searchParams.set("provider", opts.provider)
      result.searchParams.set("client_id", clientID)
      result.searchParams.set("redirect_uri", redirectURI)
      result.searchParams.set("response_type", "code")
      const pkce = await generatePKCE()
      result.searchParams.set("code_challenge_method", "S256")
      result.searchParams.set("code_challenge", pkce.challenge)
      return [pkce.verifier, result.toString()]
    },

    /**
     * Exchanges an authorization code for access and refresh tokens.
     *
     * This is called after the user completes the OAuth flow and is redirected
     * back to your app with a code query parameter. For PKCE flows (SPA apps),
     * you also pass the verifier from the challenge stored during the authorize
     * call.
     */
    async exchange(
      code: string,
      redirectURI: string,
      verifier?: string,
    ): Promise<ExchangeSuccess | ExchangeError> {
      const headers: Record<string, string> = {
        "Content-Type": "application/x-www-form-urlencoded",
      }
      const body: Record<string, string> = {
        code,
        redirect_uri: redirectURI,
        grant_type: "authorization_code",
      }
      if (input.jwt) {
        headers["Authorization"] = `Bearer ${input.jwt}`
        body["client_id"] = clientID
      } else if (input.clientSecret) {
        // Use Basic auth for confidential clients (client_id must not be in body)
        const credentials = Buffer.from(`${clientID}:${input.clientSecret}`).toString("base64")
        headers["Authorization"] = `Basic ${credentials}`
      } else {
        // Public clients include client_id in body
        body["client_id"] = clientID
      }
      if (verifier) {
        body["code_verifier"] = verifier
      }
      const tokens = await f(`${issuer}/oauth/token`, {
        method: "POST",
        headers,
        body: new URLSearchParams(body).toString(),
      })
      const json = await tokens.json()
      if (!tokens.ok) {
        const oauthError = tokenError(json)
        return {
          err: new InvalidAuthorizationCodeError(
            oauthError?.description,
            oauthError?.code,
          ),
        }
      }
      const result = Schema.decodeUnknownEither(TokenResponseSchema)(json)
      if (Either.isLeft(result)) {
        return {
          err: new InvalidAuthorizationCodeError(
            "Token endpoint returned an invalid token response",
          ),
        }
      }
      const parsed = result.right
      const resultTokens: Tokens = {
        access: parsed.access_token,
        refresh: parsed.refresh_token,
        expiresIn: parsed.expires_in,
      }
      if (parsed.refresh_expires_in !== undefined) {
        resultTokens.refreshExpiresIn = parsed.refresh_expires_in
      }
      return {
        err: false,
        tokens: resultTokens,
      }
    },
    async refresh(
      refresh: string,
      opts?: RefreshOptions,
    ): Promise<RefreshSuccess | RefreshError> {
      // Skip early check if we're requesting specific roles (force refresh)
      if (opts?.access && !opts?.scope) {
        const decoded = decodeJwt(opts.access)
        if (!decoded) {
          return {
            err: new InvalidAccessTokenError(),
          }
        }
        // allow 30s window for expiration
        if ((decoded.exp || 0) > Date.now() / 1000 + 30) {
          return {
            err: false,
          }
        }
      }
      const headers: Record<string, string> = {
        "Content-Type": "application/x-www-form-urlencoded",
      }
      const body: Record<string, string> = {
        grant_type: "refresh_token",
        refresh_token: refresh,
      }
      if (input.jwt) {
        headers["Authorization"] = `Bearer ${input.jwt}`
        body["client_id"] = clientID
      } else if (input.clientSecret) {
        // Use Basic auth for confidential clients (client_id must not be in body)
        const credentials = Buffer.from(`${clientID}:${input.clientSecret}`).toString("base64")
        headers["Authorization"] = `Basic ${credentials}`
      } else {
        // Public clients include client_id in body
        body["client_id"] = clientID
      }
      // Add scope parameter if provided (for role switching)
      if (opts?.scope) {
        body["scope"] = opts.scope
      }
      const tokens = await f(`${issuer}/oauth/token`, {
        method: "POST",
        headers,
        body: new URLSearchParams(body).toString(),
      })
      const json = await tokens.json()
      if (!tokens.ok) {
        return {
          err: new InvalidRefreshTokenError(),
        }
      }
      const result = Schema.decodeUnknownEither(TokenResponseSchema)(json)
      if (Either.isLeft(result)) {
        return {
          err: new InvalidRefreshTokenError(),
        }
      }
      const parsed = result.right
      const refreshedTokens: Tokens = {
        access: parsed.access_token,
        refresh: parsed.refresh_token,
        expiresIn: parsed.expires_in,
      }
      if (parsed.refresh_expires_in !== undefined) {
        refreshedTokens.refreshExpiresIn = parsed.refresh_expires_in
      }
      return {
        err: false,
        tokens: refreshedTokens,
      }
    },
    async verify<T extends SubjectSchema>(
      subjects: T,
      token: string,
      options?: VerifyOptions,
    ): Promise<VerifyResult<T> | VerifyError> {
      let jwks: ReturnType<typeof createLocalJWKSet>
      try {
        jwks = await getJWKS()
      } catch (error) {
        if (error instanceof OAuthMetadataFetchError) {
          return {
            err: error,
          }
        }

        return {
          err: new InvalidAccessTokenError(),
        }
      }

      try {
        const result = await jwtVerify<{
          mode: "access"
          type: keyof T
          properties: StandardSchemaV1.InferInput<T[keyof T]>
        }>(token, jwks, {
          issuer,
            audience: options?.audience ?? audience ?? clientID,
        })
        const validated = await subjects[result.payload.type]![
          "~standard"
        ].validate(result.payload.properties)
        if (!validated.issues && result.payload.mode === "access")
          return {
            aud: result.payload.aud as string,
            subject: {
              type: result.payload.type,
              properties: validated.value,
            }
          }
        return {
          err: new InvalidSubjectError(),
        }
      } catch (e) {
        if (e instanceof errors.JWTExpired && options?.refresh) {
          const refreshed = await this.refresh(options.refresh)
          if (refreshed.err) return refreshed
          const verified = await result.verify(
            subjects,
            refreshed.tokens!.access,
            {
              refresh: refreshed.tokens!.refresh,
              issuer,
              ...(options?.fetch && { fetch: options.fetch }),
            },
          )
          if (verified.err) return verified
          verified.tokens = refreshed.tokens!
          return verified
        }
        return {
          err: new InvalidAccessTokenError(),
        }
      }
    },
    async logout(refresh: string): Promise<{ success: boolean }> {
      const response = await f(`${issuer}/oauth/revoke`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          token: refresh,
        }).toString(),
      })

      if (!response.ok) {
        return { success: false }
      }

      return { success: true }
    },
  }
  return result
}
