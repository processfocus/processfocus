/**
 * The `issuer` creates an OpenAuth server using Effect's HttpRouter and HttpApp.
 *
 * The issuer is an Effect that builds an HttpRouter using services from context.
 * All configuration and dependencies are provided via Effect services.
 *
 * @example
 * ```ts
 * import { issuer } from "@pf/openauth"
 * import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
 *
 * const main = Effect.gen(function* () {
 *   const app = yield* issuer
 *   yield* Layer.launch(
 *     app.pipe(
 *       HttpServer.serve(),
 *       Layer.provide(BunHttpServer.layer({ port: 4020 }))
 *     )
 *   )
 * }).pipe(Effect.provide(allServiceLayers))
 * ```
 *
 * @packageDocumentation
 */

import {
  Headers,
  type HttpApp,
  type HttpBody,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform"
import { Data, Effect, Either, Schema } from "effect"
import {
  type AuthorizationState,
  type GeneratedTokens,
  type TokenEndpointResult,
  generateTokens,
  handleAuthorize,
  handleDiscovery,
  handleJwks,
  handleRevoke,
  handleToken,
  handleUserinfo,
} from "./endpoints"
import { cors } from "./http-middleware/cors"
import { securityHeaders } from "./http-middleware/security-headers"
import type {
  Provider,
  ProviderCallbackError,
} from "./provider/provider"
import { tryProviderCallback } from "./provider/provider"
import { getIssuerUrl, getProtocol } from "./request"
import { errorJson, noStoreJson } from "./response"
// Internal imports for local use - using aliases to avoid conflicts with re-exports
import {
  ClientRegistryService as ClientRegistrySvc,
  CookieAuthService as CookieAuthSvc,
  IssuerCallbacks as IssuerCallbacksSvc,
  ProviderRegistryService as ProviderRegistrySvc,
  TokenTtlConfig as TokenTtlCfg,
} from "./services"
import { Storage, type StorageService } from "./storage/storage"

// Re-export types
export type {
  AllowCallbackInput,
  AuthorizationState,
  ClientAuthenticationMethod,
  NormalizedClient,
  OnRefreshScopeInput,
  OnRefreshScopeResult,
  OnSuccessResponder,
  TokenTtl,
} from "./endpoints/types"
// Re-export services (separate from imports to avoid duplicate identifiers)
export {
  ClientRegistryService,
  CookieAuthService,
  CookieAuthServiceLive,
  EncryptionService,
  EncryptionServiceLive,
  IssuerCallbacks,
  KeyManagementService,
  KeyManagementServiceLive,
  ProviderRegistryService,
  SubjectsConfig,
  TokenTtlConfig,
  buildClientRegistry,
  defaultResolveSubject,
  defaultTokenTtl,
  makeClientRegistryService,
  makeIssuerCallbacks,
  makeProviderRegistryService,
  makeSubjectsConfig,
  makeTokenTtlConfig,
} from "./services"

import type { ClientAuthenticationMethod } from "./endpoints/types"

/**
 * Typed success responder for the issuer input.
 */
export interface TypedSuccessResponder<
  T extends { type: string; properties: unknown },
> {
  subject<Type extends T["type"]>(
    type: Type,
    properties: Extract<T, { type: Type }>["properties"],
    opts?: {
      ttl?: {
        access?: number
        refresh?: number
      }
      subject?: string
    },
  ): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpBody.HttpBodyError, StorageService>
}

export interface IssuerClient {
  id: string
  redirectUris: string[]
  corsOrigins?: string[]
  secretHash?: string | undefined
  tokenEndpointAuthMethod?: ClientAuthenticationMethod
  audience?: string | undefined
}

export async function hashClientSecret(secret: string): Promise<string> {
  return Bun.password.hash(secret)
}

export type Prettify<T> = {
  [K in keyof T]: T[K]
} & {}

export class ResolveIssuerClientsError extends Data.TaggedError(
  "@pf/openauth/ResolveIssuerClientsError",
)<{
  readonly message: string
}> {}

interface IssuerClientEnvFormat extends Omit<IssuerClient, "secretHash"> {
  secret?: string | undefined
  secretHash?: string | undefined
}

/**
 * Resolve issuer clients from environment variable OPENAUTH_CLIENTS.
 * Merges with any statically configured clients.
 */
export function resolveIssuerClients(
  clients?: IssuerClient[],
): Effect.Effect<IssuerClient[], ResolveIssuerClientsError> {
  return Effect.gen(function* () {
    const clientMap = new Map<string, IssuerClient>()
    for (const client of clients ?? []) {
      clientMap.set(client.id, client)
    }

    const raw = process.env["OPENAUTH_CLIENTS"]
    if (raw) {
      const parsed = yield* Schema.decodeUnknown(
        Schema.parseJson(Schema.Unknown),
      )(raw).pipe(
        Effect.mapError(
          (error) =>
            new ResolveIssuerClientsError({
              message: `OPENAUTH_CLIENTS contains invalid JSON: ${String(error)}`,
            }),
        ),
      )

      if (!Array.isArray(parsed)) {
        return yield* new ResolveIssuerClientsError({
          message: "OPENAUTH_CLIENTS must be a JSON array",
        })
      }

      for (const entry of parsed as IssuerClientEnvFormat[]) {
        const client: IssuerClient = {
          id: entry.id,
          redirectUris: entry.redirectUris,
        }
        if (entry.audience) {
          client.audience = entry.audience
        }
        if (entry.corsOrigins) {
          client.corsOrigins = entry.corsOrigins
        }
        if (entry.tokenEndpointAuthMethod) {
          client.tokenEndpointAuthMethod = entry.tokenEndpointAuthMethod
        }
        if (entry.secret && !entry.secretHash) {
          client.secretHash = yield* Effect.tryPromise({
            try: () => Bun.password.hash(entry.secret!),
            catch: (error) =>
              new ResolveIssuerClientsError({
                message: `Failed to hash secret for client ${entry.id}: ${error instanceof Error ? error.message : "unknown error"}`,
              }),
          })
          ;(entry as { secret?: string | undefined }).secret = undefined
        } else if (entry.secretHash) {
          if (entry.secretHash.trim() === "") {
            return yield* new ResolveIssuerClientsError({
              message: `Client ${entry.id} has empty secretHash - use a valid hash or omit for public clients`,
            })
          }
          client.secretHash = entry.secretHash
        }
        if (!clientMap.has(client.id)) {
          clientMap.set(client.id, client)
        }
      }
    }

    return Array.from(clientMap.values())
  })
}

/**
 * The return type of the `issuer` Effect - an HttpApp.
 */
export type Issuer = HttpApp.Default<never>

/**
 * Helper function to normalize CORS origins.
 */
function normalizeOrigin(origin: string): string {
  const parsed = new URL(origin)
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Origin must use http or https: ${origin}`)
  }
  return parsed.origin
}

/**
 * Build ProviderOptions for a provider using services from context.
 */
const buildProviderOptions = <Properties>(
  providerName: string,
  callbacks: typeof IssuerCallbacksSvc.Service,
  cookieAuth: typeof CookieAuthSvc.Service,
  clientRegistry: typeof ClientRegistrySvc.Service,
  ttlConfig: typeof TokenTtlCfg.Service,
) => ({
  name: providerName,
  invalidate: (subject: string) => cookieAuth.invalidate(subject),

  success: (properties: Properties) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest

      // Read authorization cookie
      const cookieHeader = request.headers["cookie"] ?? ""
      const authorization = (yield* cookieAuth.get(
        cookieHeader,
        "authorization",
      )) as AuthorizationState | undefined

      if (!authorization) {
        return yield* errorJson(
          "invalid_request",
          "Missing authorization state",
          400,
        )
      }

      // Call the user's success callback to get subject info
      const code = crypto.randomUUID()

      // Build the provider result object
      const providerResult =
        typeof properties === "object" && properties !== null
          ? { provider: providerName, ...(properties as Record<string, unknown>) }
          : { provider: providerName }

        const response = yield* callbacks.success(
          {
            subject(type, subjectProps, opts) {
              return Effect.gen(function* () {
              const subject =
                opts?.subject ??
                (yield* callbacks.resolveSubject(type as string, subjectProps))
              const client = clientRegistry.staticClients.get(authorization.client_id)

              // Store the authorization code
              yield* Storage.set(
                ["oauth:code", code],
                {
                  type,
                  properties: subjectProps,
                  clientID: authorization.client_id,
                  redirectURI: authorization.redirect_uri,
                  subject,
                  audience: authorization.audience ?? client?.audience,
                  ttl: {
                    access: opts?.ttl?.access ?? ttlConfig.access,
                    refresh: opts?.ttl?.refresh ?? ttlConfig.refresh,
                  },
                  pkce: authorization.pkce,
                },
                60 * 10, // 10 minute expiry for auth codes
              )

              // Build redirect URL with code
              const redirectUrl = new URL(authorization.redirect_uri)
              redirectUrl.searchParams.set("code", code)
              if (authorization.state) {
                redirectUrl.searchParams.set("state", authorization.state)
              }

              // Clear authorization cookie
              const unsetCookie = yield* cookieAuth.unset("authorization")

                return HttpServerResponse.redirect(
                  redirectUrl.toString(),
                  { status: 302 },
                ).pipe(HttpServerResponse.setHeader("Set-Cookie", unsetCookie))
              })
            },
            error(error, description) {
              return Effect.gen(function* () {
                const redirectUrl = new URL(authorization.redirect_uri)
                redirectUrl.searchParams.set("error", error)
                redirectUrl.searchParams.set("error_description", description)
                if (authorization.state) {
                  redirectUrl.searchParams.set("state", authorization.state)
                }

                const unsetCookie = yield* cookieAuth.unset("authorization")

                return HttpServerResponse.redirect(redirectUrl.toString(), {
                  status: 302,
                }).pipe(HttpServerResponse.setHeader("Set-Cookie", unsetCookie))
              })
            },
          },
          providerResult,
          request,
        )

      return response
    }),

  setCookie: (key: string, maxAge: number, value: unknown) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const isSecure = getProtocol(request.headers) === "https"
      return yield* cookieAuth.set(key, maxAge, value, isSecure)
    }),

  getCookie: <T>(key: string) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const cookieHeader = request.headers["cookie"] ?? ""
      return (yield* cookieAuth.get(cookieHeader, key)) as T | undefined
    }),

  deleteCookie: (key: string) => cookieAuth.unset(key),
})

/**
 * Create an OpenAuth server using Effect HttpRouter.
 *
 * This Effect builds the HTTP router for the OAuth server.
 * All services must be provided via Effect context:
 * - KeyManagementService
 * - EncryptionService
 * - ClientRegistryService
 * - CookieAuthService
 * - ProviderRegistryService
 * - TokenTtlConfig
 * - SubjectsConfig
 * - IssuerCallbacks
 * - StorageService
 */
export const issuer: Effect.Effect<
  Issuer,
  never,
  | ClientRegistrySvc
  | CookieAuthSvc
  | ProviderRegistrySvc
  | TokenTtlCfg
  | IssuerCallbacksSvc
  | StorageService
> = Effect.gen(function* () {
  // Get all services from context
  const clientRegistry = yield* ClientRegistrySvc
  const cookieAuth = yield* CookieAuthSvc
  const providerRegistry = yield* ProviderRegistrySvc
  const ttlConfig = yield* TokenTtlCfg
  const callbacks = yield* IssuerCallbacksSvc

  // Build token CORS origins from client configurations
  const tokenCorsOrigins = new Set<string>()
  for (const client of clientRegistry.staticClients.values()) {
    for (const origin of client.corsOrigins) {
      tokenCorsOrigins.add(normalizeOrigin(origin))
    }
  }

  // Token generation helper for success callback in token endpoint
  const generateTokensForSuccess = (
    clientId: string,
    clientAudience: string,
    type: string,
    properties: unknown,
    subject: string,
    ttl: { access: number; refresh: number },
  ) =>
    generateTokens({
      type,
      properties,
      subject,
      clientID: clientId,
      audience: clientAudience,
      ttl,
      timeUsed: undefined,
      nextToken: undefined,
    }, { generateRefreshToken: false })

  // Build routes
  const jwksRoute = HttpRouter.get(
    "/.well-known/jwks.json",
    handleJwks.pipe(
      cors({
        origin: "*",
        allowMethods: ["GET"],
      }),
    ),
  )

  const discoveryRoute = HttpRouter.get(
    "/.well-known/oauth-authorization-server",
    handleDiscovery.pipe(
      Effect.catchTag("@pf/openauth/MissingHostError", (e) =>
        errorJson("server_error", e.description, 500),
      ),
      cors({
        origin: "*",
        allowMethods: ["GET"],
      }),
    ),
  )

  const authorizeRoute = HttpRouter.get("/oauth/authorize", handleAuthorize)

  const tokenRoute = HttpRouter.post(
    "/oauth/token",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest

      // Parse form data
      const contentType = request.headers["content-type"] ?? ""
      if (!contentType.includes("application/x-www-form-urlencoded")) {
        return yield* errorJson(
          "invalid_request",
          "Content-Type must be application/x-www-form-urlencoded",
          415,
        )
      }

      const urlParams = yield* request.urlParamsBody
      const form = new Map<string, string>()
      for (const [key, value] of urlParams) {
        form.set(key, value)
      }

      const result: TokenEndpointResult = yield* handleToken(form)

      // If we got an HttpServerResponse directly, return it
      if ("status" in result && typeof result.status === "number") {
        return result as HttpServerResponse.HttpServerResponse
      }

      // Handle client credentials flows that need success callback
      if ("type" in result) {
        if (result.type === "client_credentials_direct") {
          const successEffect = callbacks.success(
            {
              subject(type, properties, opts) {
                return Effect.gen(function* () {
                  const subject =
                    opts?.subject ??
                    (yield* callbacks.resolveSubject(type as string, properties))
                  const tokens: GeneratedTokens =
                    yield* generateTokensForSuccess(
                      result.clientId,
                      result.clientAudience,
                      type as string,
                      properties,
                      subject,
                      {
                        access: opts?.ttl?.access ?? ttlConfig.access,
                        refresh: opts?.ttl?.refresh ?? ttlConfig.refresh,
                      },
                    )
                  return yield* noStoreJson({
                    access_token: tokens.access,
                    expires_in: tokens.expiresIn,
                  })
                })
              },
              error(error, description) {
                return errorJson(error, description, 400)
              },
            },
            {
              provider: "credentials",
              clientID: result.clientId,
              scope: result.scope,
            },
            request,
          )
          return yield* successEffect
        }

        if (result.type === "client_credentials_upstream") {
          const provider = yield* providerRegistry.resolveProvider(result.provider)
          if (!provider) {
            return yield* errorJson(
              "invalid_request",
              "Invalid provider parameter",
              400,
            )
          }
          if (!provider.client) {
            return yield* errorJson(
              "invalid_request",
              "Provider does not support client_credentials",
              400,
            )
          }

          const upstreamClientID = form.get("provider_client_id") ?? form.get("client_id")
          const upstreamClientSecret = form.get("provider_client_secret") ?? form.get("client_secret")

          if (!upstreamClientID || !upstreamClientSecret) {
            return yield* errorJson(
              "invalid_request",
              "Missing client credentials for upstream provider",
              400,
            )
          }

          const clientResult = yield* tryProviderCallback(
            "Provider client credentials callback failed",
            () =>
              provider.client!({
                clientID: upstreamClientID,
                clientSecret: upstreamClientSecret,
                params: Object.fromEntries(form) as Record<string, string>,
              }),
          ).pipe(Effect.either)

          if (Either.isLeft(clientResult)) {
            const error = clientResult.left
            yield* Effect.logError("Provider client callback failed").pipe(
              Effect.annotateLogs({
                message: error.message,
                cause: String(error.cause),
              }),
            )
            return yield* errorJson(
              "server_error",
              "Authentication provider callback failed",
              500,
            )
          }

          const response = clientResult.right

          // Safely handle the response - it may or may not be an object
          const providerResult =
            typeof response === "object" && response !== null
              ? { provider: result.provider, ...(response as Record<string, unknown>) }
              : { provider: result.provider }

          const successEffect = callbacks.success(
            {
              subject(type, properties, opts) {
                return Effect.gen(function* () {
                  const subject =
                    opts?.subject ??
                    (yield* callbacks.resolveSubject(type as string, properties))
                  const tokens: GeneratedTokens =
                    yield* generateTokensForSuccess(
                      result.clientId,
                      result.clientAudience,
                      type as string,
                      properties,
                      subject,
                      {
                        access: opts?.ttl?.access ?? ttlConfig.access,
                        refresh: opts?.ttl?.refresh ?? ttlConfig.refresh,
                      },
                    )
                  return yield* noStoreJson({
                    access_token: tokens.access,
                    expires_in: tokens.expiresIn,
                  })
                })
              },
              error(error, description) {
                return errorJson(error, description, 400)
              },
            },
            providerResult,
            request,
          )
          return yield* successEffect
        }
      }

      // Should not reach here
      return yield* errorJson(
        "server_error",
        "Unknown token endpoint result",
        500,
      )
    }).pipe(
      tokenCorsOrigins.size > 0
        ? cors({
            origin: Array.from(tokenCorsOrigins),
            allowHeaders: ["Content-Type", "Authorization"],
            allowMethods: ["POST"],
          })
        : (e) => e,
    ),
  )

  const userinfoRoute = HttpRouter.get(
    "/oauth/userinfo",
    handleUserinfo.pipe(
      Effect.catchTag("@pf/openauth/MissingHostError", (e) =>
        errorJson("server_error", e.description, 500),
      ),
    ),
  )

  const revokeRoute = HttpRouter.post(
    "/oauth/revoke",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest

      const urlParams = yield* request.urlParamsBody
      const form = new Map<string, string>()
      for (const [key, value] of urlParams) {
        form.set(key, value)
      }

      return yield* handleRevoke(form)
    }).pipe(
      cors({
        origin: "*",
        allowMethods: ["POST"],
      }),
    ),
  )

  // Compose all routes
  let router = HttpRouter.empty.pipe(
    jwksRoute,
    discoveryRoute,
    authorizeRoute,
    tokenRoute,
    userinfoRoute,
    revokeRoute,
  )

  // Mount static provider routes at /oauth/{providerName}/*
  for (const [providerName, provider] of providerRegistry.staticProviders) {
    const providerOptions = buildProviderOptions(
      providerName,
      callbacks,
      cookieAuth,
      clientRegistry,
      ttlConfig,
    )

    // Initialize provider and get its router
    const providerRouter = provider.init(providerOptions)

    // Mount provider router at /oauth/{providerName}/*
    const providerPrefix = `/oauth/${providerName}` as `/${string}`
    const providerRouterWithOriginalPath = providerRouter.pipe(
      HttpRouter.use((httpApp) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const subPath = new URL(request.url, "http://localhost").pathname
          const originalPath = `${providerPrefix}${subPath}`
          const modifiedRequest = request.modify({
            headers: Headers.fromInput({
              ...request.headers,
              "x-original-path": originalPath,
            }),
          })
          return yield* httpApp.pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, modifiedRequest),
            Effect.catchTag(
              "@pf/openauth/ProviderCallbackError",
              (error: ProviderCallbackError) =>
                Effect.gen(function* () {
                  yield* Effect.logError("Provider callback failed").pipe(
                    Effect.annotateLogs({
                      providerName,
                      message: error.message,
                      cause: String(error.cause),
                    }),
                  )
                  return yield* errorJson(
                    "server_error",
                    "Authentication provider callback failed",
                    500,
                  )
                }),
            ),
          )
        }),
      ),
    )

    router = router.pipe(
      HttpRouter.mount(providerPrefix, providerRouterWithOriginalPath),
    ) as typeof router
  }

  // Add dynamic provider resolution routes (catch-all for non-static providers)
  // Cache for dynamically loaded providers
  const dynamicProviders = new Map<string, Provider<unknown>>()

  const dynamicProviderHandler = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest

    // Get the proper origin from request headers
    const origin = yield* getIssuerUrl(request.headers)
    const url = new URL(request.url, origin)
    const pathParts = url.pathname.split("/").filter(Boolean)

    // Expect path like /oauth/{provider}/...
    if (pathParts.length < 2 || pathParts[0] !== "oauth") {
      return yield* HttpServerResponse.text("Provider not found", { status: 404 })
    }

    const providerName = pathParts[1]
    if (!providerName) {
      return yield* HttpServerResponse.text("Provider not found", { status: 404 })
    }

    // Skip if this provider was mounted statically
    if (providerRegistry.hasProvider(providerName)) {
      return yield* HttpServerResponse.text("Not found", { status: 404 })
    }

    // Check cache first
    let provider = dynamicProviders.get(providerName)

    if (!provider) {
      // Resolve provider dynamically
      const resolved = yield* providerRegistry.resolveProvider(providerName)

      if (!resolved) {
        return yield* HttpServerResponse.text(`Provider '${providerName}' not found`, {
          status: 404,
        })
      }

      provider = resolved
      dynamicProviders.set(providerName, provider)
    }

    // Initialize the provider's router and handle the request
    const providerOptions = buildProviderOptions(
      providerName,
      callbacks,
      cookieAuth,
      clientRegistry,
      ttlConfig,
    )
    const providerRouter = provider.init(providerOptions)

    // Build the sub-path (everything after /oauth/{provider})
    const subPath = `/${pathParts.slice(2).join("/")}`

    yield* Effect.log("Dynamic provider handling").pipe(
      Effect.annotateLogs({
        providerName,
        subPath,
        originalUrl: url.toString(),
      }),
    )

    // Modify the request URL to route to the provider's endpoints
    const providerUrl = new URL(subPath, origin)
    providerUrl.search = url.search

    const modifiedHeaders = Headers.fromInput({
      ...request.headers,
      "x-original-path": url.pathname,
    })

    const modifiedHttpRequest = request.modify({
      url: providerUrl.toString(),
      headers: modifiedHeaders,
    })

    // Run the provider router with the modified request
    const response = yield* providerRouter.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        modifiedHttpRequest,
      ),
      Effect.catchTag(
        "@pf/openauth/ProviderCallbackError",
        (error: ProviderCallbackError) =>
          Effect.gen(function* () {
            yield* Effect.logError("Provider callback failed").pipe(
              Effect.annotateLogs({
                providerName,
                subPath,
                message: error.message,
                cause: String(error.cause),
              }),
            )
            return yield* errorJson(
              "server_error",
              "Authentication provider callback failed",
              500,
            )
          }),
      ),
      Effect.catchAllCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logError("Dynamic provider handler error").pipe(
            Effect.annotateLogs({
              providerName,
              subPath,
              cause: cause.toString(),
            }),
          )
          return HttpServerResponse.text("Internal server error", { status: 500 })
        }),
      ),
    )

    yield* Effect.log("Dynamic provider response").pipe(
      Effect.annotateLogs({
        providerName,
        status: response.status,
      }),
    )

    return response
  })

  // Add catch-all routes for dynamic providers
  const dynamicProviderHandlerWithErrorHandling = dynamicProviderHandler.pipe(
    Effect.catchTag("@pf/openauth/MissingHostError", (e) =>
      errorJson("server_error", e.description, 500),
    ),
  )
  router = router.pipe(
    HttpRouter.get("/oauth/:provider/authorize", dynamicProviderHandlerWithErrorHandling),
    HttpRouter.get("/oauth/:provider/callback", dynamicProviderHandlerWithErrorHandling),
    HttpRouter.post("/oauth/:provider/callback", dynamicProviderHandlerWithErrorHandling),
    HttpRouter.post("/oauth/:provider/challenge", dynamicProviderHandlerWithErrorHandling),
    HttpRouter.post("/oauth/:provider/verify", dynamicProviderHandlerWithErrorHandling),
    HttpRouter.post("/oauth/:provider/register", dynamicProviderHandlerWithErrorHandling),
    HttpRouter.post("/oauth/:provider/register-options", dynamicProviderHandlerWithErrorHandling),
    HttpRouter.post("/oauth/:provider/register-verify", dynamicProviderHandlerWithErrorHandling),
    HttpRouter.post("/oauth/:provider/authenticate", dynamicProviderHandlerWithErrorHandling),
    HttpRouter.post("/oauth/:provider/auth-options", dynamicProviderHandlerWithErrorHandling),
    HttpRouter.post("/oauth/:provider/auth-verify", dynamicProviderHandlerWithErrorHandling),
    HttpRouter.post(
      "/oauth/:provider/registration-session-exchange",
      dynamicProviderHandlerWithErrorHandling,
    ),
  ) as typeof router

  // Apply middleware
  return router.pipe(
    HttpRouter.use((app) => Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (getProtocol(request.headers) === undefined) {
        return yield* errorJson("invalid_request", "Invalid forwarded protocol header", 400)
      }
      return yield* app
    })),
    HttpRouter.use(securityHeaders),
  ) as unknown as Issuer
})
