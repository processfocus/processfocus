/**
 * Use this to connect authentication providers that support OAuth 2.0.
 *
 * ```ts {5-12}
 * import { Oauth2Provider } from "@openauthjs/openauth/provider/oauth2"
 *
 * export default issuer({
 *   providers: {
 *     oauth2: Oauth2Provider({
 *       clientID: "1234567890",
 *       clientSecret: "0987654321",
 *       endpoint: {
 *         authorization: "https://auth.myserver.com/authorize",
 *         token: "https://auth.myserver.com/token"
 *       }
 *     })
 *   }
 * })
 * ```
 *
 *
 * @packageDocumentation
 */

import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform"
import { Effect } from "effect"
import { createRemoteJWKSet, jwtVerify } from "jose"
import { OauthError } from "../error"
import { generatePKCE } from "../pkce"
import { getRelativeUrl } from "../request"
import { errorJson } from "../response"
import type { KeyManagementService } from "../services/key-management"
import type { StorageService } from "../storage/storage"
import type {
  Provider,
  ProviderOptions,
  ProviderSubjectIdentity,
  VerifiedHumanIdentity,
} from "./provider"
import { ProviderError } from "./provider"

type OauthErrorCode =
  | "invalid_request"
  | "invalid_grant"
  | "unauthorized_client"
  | "invalid_client"
  | "access_denied"
  | "unsupported_grant_type"
  | "server_error"
  | "temporarily_unavailable"

/**
 * Map arbitrary error string to valid OAuth error code.
 */
const toOauthErrorCode = (error: string): OauthErrorCode => {
  const validCodes: OauthErrorCode[] = [
    "invalid_request",
    "invalid_grant",
    "unauthorized_client",
    "invalid_client",
    "access_denied",
    "unsupported_grant_type",
    "server_error",
    "temporarily_unavailable",
  ]
  return validCodes.includes(error as OauthErrorCode)
    ? (error as OauthErrorCode)
    : "server_error"
}

/** Map callback failures: access_denied is an auth denial, not a server fault. */
const oauthCallbackFailureResponse = (context: string, error: unknown) =>
  Effect.gen(function* () {
    if (error instanceof OauthError && error.error === "access_denied") {
      yield* Effect.logWarning(`${context}: access denied`).pipe(
        Effect.annotateLogs({
          error: error.error,
          description: error.description,
        }),
      )
      return yield* errorJson(
        "access_denied",
        "Unable to complete sign-in",
        403,
      )
    }
    yield* Effect.logError(`${context} failed`).pipe(
      Effect.annotateLogs({ error: String(error) }),
    )
    return yield* errorJson("server_error", "OAuth2 callback failed", 500)
  })



export interface Oauth2Config {
  /**
   * @internal
   */
  type?: string
  /**
   * The client ID.
   *
   * This is just a string to identify your app.
   *
   * @example
   * ```ts
   * {
   *   clientID: "my-client"
   * }
   * ```
   */
  clientID: string
  /**
   * The client secret.
   *
   * This is a private key that's used to authenticate your app. It should be kept secret.
   *
   * @example
   * ```ts
   * {
   *   clientSecret: "0987654321"
   * }
   * ```
   */
  clientSecret: string
  /**
   * The URLs of the authorization and token endpoints.
   *
   * @example
   * ```ts
   * {
   *   endpoint: {
   *     authorization: "https://auth.myserver.com/authorize",
   *     token: "https://auth.myserver.com/token",
   *     jwks: "https://auth.myserver.com/auth/keys"
   *   }
   * }
   * ```
   */
  endpoint: {
    /**
     * The URL of the authorization endpoint.
     */
    authorization: string
    /**
     * The URL of the token endpoint.
     */
    token: string
    /**
     * The URL of the JWKS endpoint.
     */
    jwks?: string
  }
  /** Expected issuer for OIDC ID tokens. Enables issuer and nonce verification. */
  issuer?: string | string[]
  /** Validate providers whose discovery issuer contains a tenant placeholder. */
  validateIssuer?: (issuer: unknown) => boolean
  /** Build a verified identity from a protocol-verified OIDC ID token. */
  mapVerifiedHumanIdentity?:
    | ((
        payload: Record<string, unknown>,
      ) => VerifiedHumanIdentity | undefined)
    | undefined
  /** Resolve a stable subject and, when available, verified identity via provider APIs. */
  resolveHumanIdentity?:
    | ((tokenset: Oauth2Token) => Promise<HumanIdentityResolution>)
    | undefined
  /**
   * A list of OAuth scopes that you want to request.
   *
   * @example
   * ```ts
   * {
   *   scopes: ["email", "profile"]
   * }
   * ```
   */
  scopes: string[]
  /**
   * Whether to use PKCE (Proof Key for Code Exchange) for the authorization code flow.
   * Some providers like x.com require this.
   * @default false
   */
  pkce?: boolean
  /**
   * Any additional parameters that you want to pass to the authorization endpoint.
   * @example
   * ```ts
   * {
   *   query: {
   *     access_type: "offline",
   *     prompt: "consent"
   *   }
   * }
   * ```
   */
  query?: Record<string, string>
}

/**
 * @internal
 */
export type Oauth2WrappedConfig = Omit<
  Oauth2Config,
  | "endpoint"
  | "name"
  | "issuer"
  | "validateIssuer"
  | "mapVerifiedHumanIdentity"
  | "resolveHumanIdentity"
>

/**
 * @internal
 */
export interface Oauth2Token {
  access: string
  refresh: string
  expiry: number
  id?: Record<string, unknown>
  raw: Record<string, unknown>
}

interface ProviderState {
  state: string
  redirect: string
  codeVerifier?: string
  nonce?: string
}

export interface Oauth2Properties {
  readonly tokenset: Oauth2Token
  readonly clientID: string
}

export interface HumanIdentityResolution {
  readonly claims: Record<string, unknown>
  readonly verifiedIdentity?: VerifiedHumanIdentity
}

/**
 * Result for human OAuth/OIDC providers that resolve identity evidence.
 * Tokenset payloads are never returned; bootstrap requires verified identity.
 */
export type Oauth2Result = VerifiedHumanIdentity | ProviderSubjectIdentity

const claimsSubject = (
  claims: Record<string, unknown> | null | undefined,
): string | undefined => {
  const subject = claims?.["sub"]
  return typeof subject === "string" && subject.length > 0 ? subject : undefined
}

const claimsPicture = (
  claims: Record<string, unknown> | null | undefined,
): string | undefined => {
  const picture = claims?.["picture"]
  return typeof picture === "string" && picture.length > 0 ? picture : undefined
}

const subjectIdentity = (
  provider: string,
  subject: string,
  picture?: string,
): ProviderSubjectIdentity => ({
  type: "provider-subject-identity",
  provider,
  subject,
  ...(picture ? { picture } : {}),
})

export function Oauth2Provider(
  config: Oauth2Config & {
    readonly issuer: NonNullable<Oauth2Config["issuer"]>
    readonly mapVerifiedHumanIdentity: NonNullable<
      Oauth2Config["mapVerifiedHumanIdentity"]
    >
  },
): Provider<Oauth2Result>
export function Oauth2Provider(
  config: Oauth2Config & {
    readonly resolveHumanIdentity: NonNullable<
      Oauth2Config["resolveHumanIdentity"]
    >
  },
): Provider<Oauth2Result>
export function Oauth2Provider(
  config: Omit<
    Oauth2Config,
    "mapVerifiedHumanIdentity" | "resolveHumanIdentity"
  > & {
    readonly mapVerifiedHumanIdentity?: undefined
    readonly resolveHumanIdentity?: undefined
  },
): Provider<Oauth2Properties>
export function Oauth2Provider(
  config: Oauth2Config,
): Provider<Oauth2Result | Oauth2Properties> {
  if (config.mapVerifiedHumanIdentity && !config.issuer) {
    throw new ProviderError(
      "Verified human identity mapping requires an OIDC issuer",
    )
  }

  const query = config.query || {}
  const humanIdentityConfigured = Boolean(
    config.mapVerifiedHumanIdentity || config.resolveHumanIdentity,
  )
  const providerName = config.type || "oauth2"

  /**
   * Helper function to handle token exchange and response building.
   */
  const handleCallbackLogic = (
    options: ProviderOptions<Oauth2Result | Oauth2Properties>,
    provider: ProviderState,
    code: string,
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    HttpServerRequest.HttpServerRequest | StorageService | KeyManagementService
  > =>
    Effect.gen(function* () {
      const body = new URLSearchParams({
        client_id: config.clientID,
        client_secret: config.clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: provider.redirect,
        ...(provider.codeVerifier
          ? { code_verifier: provider.codeVerifier }
          : {}),
      })

      const json: Record<string, unknown> = yield* Effect.tryPromise({
        try: async () => {
          const response = await fetch(config.endpoint.token, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Accept: "application/json",
            },
            body: body.toString(),
          })
          const value: unknown = await response.json()
          if (
            !response.ok ||
            typeof value !== "object" ||
            value === null ||
            Array.isArray(value)
          ) {
            throw new Error("Invalid token response")
          }
          return value as Record<string, unknown>
        },
        catch: () => new OauthError("server_error", "Token exchange failed"),
      }).pipe(
        Effect.withSpan("oauth2.tokenExchange", {
          attributes: { "oauth2.token_endpoint": config.endpoint.token },
        }),
      )

      if ("error" in json) {
        return yield* Effect.fail(
          new OauthError(
            toOauthErrorCode(json["error"] as string),
            (json["error_description"] as string) ?? "",
          ),
        )
      }

      let idTokenPayload: Record<string, unknown> | null = null
      if (config.endpoint.jwks && json["id_token"]) {
        const jwksEndpoint = new URL(config.endpoint.jwks)
        const jwks = createRemoteJWKSet(jwksEndpoint)
        const { payload } = yield* Effect.tryPromise({
          try: () =>
            jwtVerify(json["id_token"] as string, jwks, {
              audience: config.clientID,
              ...(config.issuer && !config.validateIssuer
                ? { issuer: config.issuer }
                : {}),
            }),
          catch: () =>
            new OauthError("server_error", "ID token verification failed"),
        }).pipe(
          Effect.withSpan("oauth2.verifyIdToken", {
            attributes: { "oauth2.jwks_endpoint": config.endpoint.jwks },
          }),
        )
        if (config.validateIssuer && !config.validateIssuer(payload["iss"])) {
          return yield* Effect.fail(
            new OauthError("invalid_request", "Invalid ID token issuer"),
          )
        }
        if (provider.nonce && payload["nonce"] !== provider.nonce) {
          return yield* Effect.fail(
            new OauthError("invalid_request", "Invalid ID token nonce"),
          )
        }
        idTokenPayload = payload as Record<string, unknown>
      }

      const tokenset: Oauth2Token = {
        access: json["access_token"] as string,
        refresh: json["refresh_token"] as string,
        expiry: json["expires_in"] as number,
        raw: json,
        ...(idTokenPayload ? { id: idTokenPayload } : {}),
      }

      if (!humanIdentityConfigured) {
        return yield* options.success({
          clientID: config.clientID,
          tokenset,
        })
      }

      const oidcIdentity = idTokenPayload
        ? config.mapVerifiedHumanIdentity?.(idTokenPayload)
        : undefined

      const resolveHumanIdentity = config.resolveHumanIdentity
      const apiResolution =
        resolveHumanIdentity && !oidcIdentity
          ? yield* Effect.tryPromise({
              try: () => resolveHumanIdentity(tokenset),
              catch: () =>
                new OauthError(
                  "server_error",
                  "Provider identity lookup failed",
                ),
            }).pipe(Effect.withSpan("oauth2.resolveHumanIdentity"))
          : undefined

      const verifiedIdentity =
        oidcIdentity ?? apiResolution?.verifiedIdentity
      if (verifiedIdentity) {
        return yield* options.success(verifiedIdentity)
      }

      const subject =
        claimsSubject(idTokenPayload) ?? claimsSubject(apiResolution?.claims)
      if (!subject) {
        // Authorization denial, not a server fault — surface access_denied
        // rather than letting catchAll collapse this into a generic 500.
        yield* Effect.logWarning(
          "OAuth2 human identity unavailable for bootstrap",
        ).pipe(
          Effect.annotateLogs({
            provider: providerName,
            hasIdToken: idTokenPayload !== null,
            hasApiClaims: apiResolution !== undefined,
          }),
        )
        return yield* errorJson(
          "access_denied",
          "Unable to complete sign-in",
          403,
        )
      }

      return yield* options.success(
        subjectIdentity(
          providerName,
          subject,
          claimsPicture(idTokenPayload) ??
            claimsPicture(apiResolution?.claims),
        ),
      )
    }).pipe(
      Effect.catchAll((error) =>
        oauthCallbackFailureResponse("OAuth2 callback logic", error),
      ),
    )

  return {
    type: providerName,
    init(options: ProviderOptions<Oauth2Result | Oauth2Properties>) {
      // GET /authorize - Start OAuth flow
      const authorizeHandler = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const state = crypto.randomUUID()
        const nonce = config.issuer ? crypto.randomUUID() : undefined
        const pkce = config.pkce ? yield* Effect.promise(() => generatePKCE()) : undefined
        const callbackUrl = yield* getRelativeUrl(request, "./callback")

        // Set provider state cookie
        const cookieValue = yield* options.setCookie("provider", 60 * 10, {
          state,
          redirect: callbackUrl,
          ...(pkce?.verifier && { codeVerifier: pkce.verifier }),
          ...(nonce ? { nonce } : {}),
        } as ProviderState)

        // Build authorization URL
        const authorization = new URL(config.endpoint.authorization)
        authorization.searchParams.set("client_id", config.clientID)
        authorization.searchParams.set("redirect_uri", callbackUrl)
        authorization.searchParams.set("response_type", "code")
        authorization.searchParams.set("state", state)
        authorization.searchParams.set("scope", config.scopes.join(" "))
        if (nonce) authorization.searchParams.set("nonce", nonce)
        if (pkce) {
          authorization.searchParams.set("code_challenge", pkce.challenge)
          authorization.searchParams.set("code_challenge_method", pkce.method)
        }
        for (const [key, value] of Object.entries(query)) {
          authorization.searchParams.set(key, value)
        }

        return HttpServerResponse.redirect(authorization.toString(), { status: 302 }).pipe(
          HttpServerResponse.setHeader("Set-Cookie", cookieValue),
        )
      }).pipe(
        Effect.catchTag("@pf/openauth/MissingHostError", (error) =>
          errorJson("server_error", error.description, 500),
        ),
      )

      // GET /callback - Handle OAuth callback via query params
      const callbackGetHandler = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url)
        const provider = yield* options.getCookie<ProviderState>("provider")
        const code = url.searchParams.get("code")
        const state = url.searchParams.get("state")
        const error = url.searchParams.get("error")
        const errorDescription = url.searchParams.get("error_description")

        if (error) {
          return yield* Effect.fail(new OauthError(toOauthErrorCode(error), errorDescription ?? ""))
        }

        if (!provider || !code || (provider.state && state !== provider.state)) {
          return HttpServerResponse.redirect(yield* getRelativeUrl(request, "./authorize"), {
            status: 302,
          })
        }

        return yield* handleCallbackLogic(options, provider, code)
      }).pipe(
        Effect.catchAll((error) =>
          oauthCallbackFailureResponse("OAuth2 callback GET", error),
        ),
      )

      // POST /callback - Handle OAuth callback via form data
      const callbackPostHandler = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const provider = yield* options.getCookie<ProviderState>("provider")

        const urlParams = yield* request.urlParamsBody
        const formData = new Map<string, string>()
        for (const [key, value] of urlParams) {
          formData.set(key, value)
        }
        const code = formData.get("code") ?? null
        const state = formData.get("state") ?? null
        const error = formData.get("error") ?? null
        const errorDescription = formData.get("error_description") ?? null

        if (error) {
          return yield* Effect.fail(new OauthError(toOauthErrorCode(error), errorDescription ?? ""))
        }

        if (!provider || !code || (provider.state && state !== provider.state)) {
          return HttpServerResponse.redirect(yield* getRelativeUrl(request, "./authorize"), {
            status: 302,
          })
        }

        return yield* handleCallbackLogic(options, provider, code)
      }).pipe(
        Effect.catchAll((error) =>
          oauthCallbackFailureResponse("OAuth2 callback POST", error),
        ),
      )

      return HttpRouter.empty.pipe(
        HttpRouter.get("/authorize", authorizeHandler),
        HttpRouter.get("/callback", callbackGetHandler),
        HttpRouter.post("/callback", callbackPostHandler),
      )
    },
  }
}
