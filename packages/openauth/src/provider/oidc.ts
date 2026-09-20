/**
 * Use this to connect authentication providers that support OIDC.
 *
 * ```ts {5-8}
 * import { OidcProvider } from "@openauthjs/openauth/provider/oidc"
 *
 * export default issuer({
 *   providers: {
 *     oauth2: OidcProvider({
 *       clientID: "1234567890",
 *       issuer: "https://auth.myserver.com"
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
import type { JSONWebKeySet, JWTPayload } from "jose"
import { createLocalJWKSet, jwtVerify } from "jose"
import type { WellKnown } from "../client"
import { OauthError } from "../error"
import { getRelativeUrl } from "../request"
import { errorJson } from "../response"
import { lazy } from "../util"
import type { Provider, ProviderOptions } from "./provider"

type OauthErrorCode =
  | "invalid_request"
  | "invalid_grant"
  | "unauthorized_client"
  | "invalid_client"
  | "access_denied"
  | "unsupported_grant_type"
  | "server_error"
  | "temporarily_unavailable"

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



export interface OidcConfig {
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
   * The URL of your authorization server.
   *
   * @example
   * ```ts
   * {
   *   issuer: "https://auth.myserver.com"
   * }
   * ```
   */
  issuer: string
  /**
   * A list of OIDC scopes that you want to request.
   *
   * @example
   * ```ts
   * {
   *   scopes: ["openid", "profile", "email"]
   * }
   * ```
   */
  scopes?: string[]
  /**
   * Any additional parameters that you want to pass to the authorization endpoint.
   * @example
   * ```ts
   * {
   *   query: {
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
export type OidcWrappedConfig = Omit<OidcConfig, "issuer" | "name">

interface ProviderState {
  state: string
  nonce: string
  redirect: string
}

/**
 * @internal
 */
export interface IdTokenResponse {
  idToken: string
  claims: Record<string, any>
  raw: Record<string, any>
}

export function OidcProvider(
  config: OidcConfig,
): Provider<{ id: JWTPayload; clientID: string }> {
  const query = config.query || {}
  const scopes = config.scopes || []

  const wk = lazy(() =>
    fetch(`${config.issuer}/.well-known/openid-configuration`).then(
      async (r) => {
        if (!r.ok) throw new Error(await r.text())
        return r.json() as Promise<WellKnown>
      },
    ),
  )

  const jwks = lazy(() =>
    wk()
      .then((r) => r.jwks_uri)
      .then(async (uri) => {
        const r = await fetch(uri)
        if (!r.ok) throw new Error(await r.text())
        return createLocalJWKSet((await r.json()) as JSONWebKeySet)
      }),
  )

  return {
    type: config.type || "oidc",
    init(options: ProviderOptions<{ id: JWTPayload; clientID: string }>) {
      // GET /authorize - Start OIDC flow
      const authorizeHandler = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const providerState: ProviderState = {
          state: crypto.randomUUID(),
          nonce: crypto.randomUUID(),
          redirect: yield* getRelativeUrl(request, "./callback"),
        }

        const cookieValue = yield* options.setCookie("provider", 60 * 10, providerState)

        const wellKnown = yield* Effect.tryPromise({
          try: () => wk(),
          catch: () => new OauthError("server_error", "Failed to fetch OIDC configuration"),
        })

        const authorization = new URL(wellKnown.authorization_endpoint)
        authorization.searchParams.set("client_id", config.clientID)
        authorization.searchParams.set("response_type", "id_token")
        authorization.searchParams.set("response_mode", "form_post")
        authorization.searchParams.set("state", providerState.state)
        authorization.searchParams.set("nonce", providerState.nonce)
        authorization.searchParams.set("redirect_uri", providerState.redirect)
        authorization.searchParams.set("scope", ["openid", ...scopes].join(" "))
        for (const [key, value] of Object.entries(query)) {
          authorization.searchParams.set(key, value)
        }

        return HttpServerResponse.redirect(authorization.toString(), { status: 302 }).pipe(
          HttpServerResponse.setHeader("Set-Cookie", cookieValue),
        )
      }).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            yield* Effect.logError("OIDC authorize failed").pipe(
              Effect.annotateLogs({ error: String(error) }),
            )
            return yield* errorJson("server_error", "OIDC authorize failed", 500)
          }),
        ),
      )

      // POST /callback - Handle OIDC callback
      const callbackHandler = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const providerState = yield* options.getCookie<ProviderState>("provider")

        if (!providerState) {
          return HttpServerResponse.redirect(yield* getRelativeUrl(request, "./authorize"), {
            status: 302,
          })
        }

        const urlParams = yield* request.urlParamsBody
        const body = new Map<string, string>()
        for (const [key, value] of urlParams) {
          body.set(key, value)
        }
        const error = body.get("error") ?? null
        if (error) {
          return yield* Effect.fail(
            new OauthError(toOauthErrorCode(error), body.get("error_description") ?? ""),
          )
        }

        const idToken = body.get("id_token") ?? null
        if (!idToken) {
          return yield* Effect.fail(new OauthError("invalid_request", "Missing id_token"))
        }

        const jwksSet = yield* Effect.tryPromise({
          try: () => jwks(),
          catch: () => new OauthError("server_error", "Failed to fetch JWKS"),
        }).pipe(Effect.withSpan("oidc.fetchJwks"))

        const result = yield* Effect.tryPromise({
          try: () => jwtVerify(idToken, jwksSet, { audience: config.clientID }),
          catch: () => new OauthError("server_error", "ID token verification failed"),
        }).pipe(Effect.withSpan("oidc.verifyIdToken"))

        if (result.payload["nonce"] !== providerState.nonce) {
          return yield* Effect.fail(new OauthError("invalid_request", "Invalid nonce"))
        }

        return yield* options.success({
          id: result.payload,
          clientID: config.clientID,
        })
      }).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            yield* Effect.logError("OIDC callback failed").pipe(
              Effect.annotateLogs({ error: String(error) }),
            )
            return yield* errorJson("server_error", "OIDC callback failed", 500)
          }),
        ),
      )

      return HttpRouter.empty.pipe(
        HttpRouter.get("/authorize", authorizeHandler),
        HttpRouter.post("/callback", callbackHandler),
      )
    },
  }
}
