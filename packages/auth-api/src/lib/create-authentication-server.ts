import type { HttpClient } from "@effect/platform"
import { HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { Data, DateTime, Effect, Layer, Option, Runtime, Schema } from "effect"
import { SignJWT } from "jose"
import {
  getAudience,
  getClientId,
  stripTrailingSlash,
  subjects,
} from "@pf/auth-session"
import {
  type AllowCallbackInput,
  type ClientRegistryError,
  ClientRegistryService,
  CookieAuthServiceLive,
  EncryptionServiceLive,
  GoogleProvider,
  type Issuer,
  type IssuerClient,
  KeyManagementService,
  KeyManagementServiceLive,
  OnRefreshScopeError,
  type PasskeyConfig,
  type PasskeyProperties,
  PasskeyProvider,
  type ResolveIssuerClientsError,
  type StorageService,
  defaultResolveSubject,
  defaultTokenTtl,
  issuer,
  makeClientRegistryService,
  makeIssuerCallbacks,
  makeProviderRegistryService,
  makeSubjectsConfig,
  makeTokenTtlConfig,
  resolveIssuerClients,
} from "@pf/openauth"
import { makeDelegationExchangeHandler } from "./delegation-exchange.js"
import { makeDelegationManagementHandler } from "./delegation-management.js"
import { DelegationSessionService } from "./delegation-session.js"
import { InvariantViolationError } from "./invariant-violation-error.js"
import { makePasskeyManagementHandler } from "./passkey-management.js"
import {
  exchangePasskeyRecoveryLink,
  hashPasskeyRecoveryBearer,
  isPasskeyRecoveryLink,
  isPasskeyRecoverySession,
  resolvePasskeyRecoverySession,
} from "./passkey-recovery.js"
import { getPasskeyUserHandle } from "./passkey-user-handle.js"

const FRONTEND_JWT_TTL_SECONDS = 10 * 365 * 24 * 60 * 60

/**
 * Format an error for logs. Walks nested `cause` (native Error.cause and
 * Effect tagged-error fields) so DatabaseQueryError/DatabaseWriteError wrappers
 * still surface driver detail. Not for API client copy.
 */
const formatUnknownError = (cause: unknown): string => {
  const parts: string[] = []
  let current: unknown = cause
  for (let depth = 0; depth < 8 && current != null; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.message)
      const taggedCause =
        "cause" in current
          ? (current as { readonly cause?: unknown }).cause
          : undefined
      current = current.cause ?? taggedCause
      continue
    }
    if (
      typeof current === "object" &&
      current !== null &&
      "message" in current &&
      typeof (current as { message: unknown }).message === "string"
    ) {
      parts.push((current as { message: string }).message)
      current =
        "cause" in current
          ? (current as { readonly cause?: unknown }).cause
          : undefined
      continue
    }
    parts.push(String(current))
    break
  }
  return parts.length > 0 ? parts.join(" | ") : String(cause)
}

export class ClientJwtMintError extends Data.TaggedError("ClientJwtMintError")<{
  readonly message: string
}> {}

export class FrontendJwtCreateError extends Data.TaggedError(
  "FrontendJwtCreateError",
)<{
  readonly message: string
  readonly cause?: unknown
}> {}

const createFrontendJwt = (
  clientId: string,
  issuerUrl: string,
  audience: string,
  issuedAtUnixSeconds: number,
): Effect.Effect<string, FrontendJwtCreateError, KeyManagementService> =>
  Effect.gen(function* () {
    const keyMgmt = yield* KeyManagementService
    const signingKey = yield* keyMgmt.signingKey

    const token = yield* Effect.tryPromise({
      try: () =>
        new SignJWT({
          mode: "access",
          // OpenAuth subject key "user" maps to M2M/service-account sessions in this codebase.
          // Human logins use subject type "providerUser".
          type: "user",
          properties: {
            userId: `frontend:${clientId}`,
            clientId,
            roles: [],
          },
        })
          .setProtectedHeader({ alg: signingKey.alg, kid: signingKey.id })
          .setIssuer(issuerUrl)
          .setAudience(audience)
          .setSubject(`frontend:${clientId}`)
          .setIssuedAt(issuedAtUnixSeconds)
          .setExpirationTime(issuedAtUnixSeconds + FRONTEND_JWT_TTL_SECONDS)
          .sign(signingKey.private),
      catch: (cause) =>
        new FrontendJwtCreateError({
          // Stable boundary message; driver/detail stays on cause only.
          message: "Failed to create frontend JWT",
          cause,
        }),
    })

    return token
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof FrontendJwtCreateError
        ? cause
        : new FrontendJwtCreateError({
            message: "Failed to create frontend JWT",
            cause,
          }),
    ),
  )

/**
 * Discriminated union of all provider result types.
 * The `provider` field acts as the discriminant for type narrowing.
 */
type ProviderResult =
  | Oauth2Value // Dummy provider tokenset path only
  | VerifiedHumanIdentity
  | ProviderSubjectIdentity
  | (PasskeyProperties & { provider: "passkey" }) // Passkey authentication
  | CredentialsValue // M2M client credentials

import { AppleProvider } from "@pf/openauth/provider/apple"
import { CognitoProvider } from "@pf/openauth/provider/cognito"
import { DiscordProvider } from "@pf/openauth/provider/discord"
import {
  type DummyProperties,
  DummyProvider,
} from "@pf/openauth/provider/dummy"
import { FacebookProvider } from "@pf/openauth/provider/facebook"
import { GithubProvider } from "@pf/openauth/provider/github"
import { JumpCloudProvider } from "@pf/openauth/provider/jumpcloud"
import { KeycloakProvider } from "@pf/openauth/provider/keycloak"
import { LinkedInAdapter } from "@pf/openauth/provider/linkedin"
import { MicrosoftProvider } from "@pf/openauth/provider/microsoft"
import type { Oauth2WrappedConfig } from "@pf/openauth/provider/oauth2"
import type {
  Provider,
  ProviderSubjectIdentity,
  VerifiedHumanIdentity,
} from "@pf/openauth/provider/provider"
import { SlackProvider } from "@pf/openauth/provider/slack"
import { SpotifyProvider } from "@pf/openauth/provider/spotify"
import { TwitchProvider } from "@pf/openauth/provider/twitch"
import { XProvider } from "@pf/openauth/provider/x"
import { YahooProvider } from "@pf/openauth/provider/yahoo"
import { isValidRedirectUri } from "@pf/openauth/redirect-uri"
import {
  Storage,
  type StorageError,
  StorageService as StorageServiceTag,
} from "@pf/openauth/storage"
import { AuthenticationDatabase } from "./authentication-database.js"
import { resolveInviteOnlyForProvider } from "./invite-only.js"
import {
  INVITATION_REGISTRATION_INVALID_MESSAGE,
  OPEN_REGISTRATION_DENIED_MESSAGE,
  type PasskeyCounterError,
  type PasskeyCredentialAlreadyOwnedError,
  type PasskeyIdentityNotFoundError,
  type PasskeyInvitationRegistrationDeniedError,
  PasskeyOpenRegistrationDeniedError,
  authorizePasskeyOpenRegistration,
} from "./passkey-auth.js"
import {
  type CredentialsValue,
  handleConfidentialClientSuccess,
} from "./provider/confidential-client.js"
import { type Oauth2Value, handleOauth2Success } from "./provider/oauth2.js"
import { handlePasskeySuccess } from "./provider/passkey.js"
import type {
  DummyProviderUserNotFoundError,
  InviteRequiredError,
  ProviderUserEmailAlreadyOwnedError,
  VerifiedEmailRequiredError,
} from "./provider-user-auth.js"

/**
 * Error thrown when provider user authentication fails
 */
export class ProviderUserAuthenticationError extends Data.TaggedError(
  "ProviderUserAuthenticationError",
)<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Error thrown when an unsupported OAuth provider is used
 */
export class UnsupportedProviderError extends Data.TaggedError(
  "UnsupportedProviderError",
)<{
  readonly provider: string
}> {}

/**
 * Error thrown when no OAuth providers are configured
 */
export class ProviderConfigurationError extends Data.TaggedError(
  "ProviderConfigurationError",
)<{
  readonly message: string
}> {}

/**
 * Error thrown when OAuth provider config from database is invalid
 */
export class InvalidProviderConfigError extends Data.TaggedError(
  "InvalidProviderConfigError",
)<{
  readonly providerName: string
  readonly cause: unknown
}> {}

export { InvariantViolationError }

/**
 * Error thrown when invalid role scopes are requested
 */
export class InvalidRoleScopeError extends Data.TaggedError(
  "InvalidRoleScopeError",
)<{
  readonly invalidRoles: readonly string[]
  readonly requestedRoles: readonly string[]
  readonly userId: string
}> {}

/**
 * Schema for validating OAuth2 provider configuration from database.
 * Requires base Oauth2WrappedConfig fields but allows additional provider-specific fields.
 */
const Oauth2WrappedConfigSchema = Schema.Struct({
  clientID: Schema.String,
  clientSecret: Schema.String,
  scopes: Schema.mutable(Schema.Array(Schema.String)),
  pkce: Schema.optional(Schema.Boolean),
  query: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
  responseMode: Schema.optional(Schema.Literal("query", "form_post")),
  tenant: Schema.optional(Schema.String),
  team: Schema.optional(Schema.String),
  baseUrl: Schema.optional(Schema.String),
  realm: Schema.optional(Schema.String),
  domain: Schema.optional(Schema.String),
  region: Schema.optional(Schema.String),
  userPoolId: Schema.optional(Schema.String),
}).pipe(
  Schema.extend(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
)

const hasRequiredProviderConfig = (
  name: string,
  config: Record<string, unknown>,
): boolean => {
  const requiredFields: Partial<Record<string, readonly string[]>> = {
    cognito: ["domain", "region"],
    keycloak: ["baseUrl", "realm"],
    microsoft: ["tenant"],
    slack: ["team"],
  }
  return (requiredFields[name] ?? []).every(
    (field) => typeof config[field] === "string" && config[field].length > 0,
  )
}

/**
 * Schema for validating Passkey provider configuration from database.
 */
const PasskeyConfigSchema = Schema.Struct({
  rpName: Schema.String,
  rpID: Schema.String,
  origin: Schema.Union(
    Schema.String,
    Schema.mutable(Schema.Array(Schema.String)),
  ),
})

type Oauth2Provider = Provider<VerifiedHumanIdentity | ProviderSubjectIdentity>
type Oauth2ProviderFactory = (config: Oauth2WrappedConfig) => Oauth2Provider

/**
 * Factory functions for creating OAuth2 providers from configuration.
 * Maps provider names to their respective factory functions.
 *
 * All providers return OAuth2-based providers with access/refresh tokens and ID tokens.
 * Providers with extended config requirements (Microsoft, Slack, Keycloak, Cognito) are
 * cast to the base factory type - the database is expected to provide correct configs.
 */
const providerFactories: Record<string, Oauth2ProviderFactory> = {
  google: GoogleProvider,
  github: GithubProvider,
  microsoft: MicrosoftProvider as Oauth2ProviderFactory,
  apple: AppleProvider,
  discord: DiscordProvider,
  spotify: SpotifyProvider,
  slack: SlackProvider as Oauth2ProviderFactory,
  linkedin: LinkedInAdapter,
  twitch: TwitchProvider,
  yahoo: YahooProvider,
  x: XProvider,
  keycloak: KeycloakProvider as Oauth2ProviderFactory,
  cognito: CognitoProvider as Oauth2ProviderFactory,
  jumpcloud: JumpCloudProvider,
  facebook: FacebookProvider,
}

/**
 * Check if the dummy provider is allowed based on environment.
 * Only enabled when NODE_ENV is not 'production'.
 */
const isDummyProviderAllowed = () => process.env["NODE_ENV"] !== "production"

/**
 * Build frontend client configuration for local development.
 * Only used when OPENAUTH_CLIENTS is not set and NODE_ENV is "development".
 *
 * Frontend client authenticates with a client JWT and defaults to id "frontend".
 */
export const buildFrontendClients = async (): Promise<IssuerClient[]> => {
  if (process.env["NODE_ENV"] !== "development") {
    return []
  }
  const clients = process.env["OPENAUTH_CLIENTS"]
  if (clients) {
    return []
  }

  const clientId = getClientId()
  const audience = getAudience()
  // http://localhost (without port) acts as a wildcard for any localhost port
  const redirectUris = ["http://localhost/api/auth/callback"]

  return [
    {
      id: clientId,
      redirectUris,
      audience,
      tokenEndpointAuthMethod: "client_jwt" as const,
    },
  ]
}

/**
 * Options for creating the authentication server.
 */
export interface CreateAuthenticationServerOptions {
  /**
   * Configuration for the dummy provider. When set, enables the dummy provider
   * for testing (bypasses database providers). Only works when NODE_ENV is not
   * 'production'.
   */
  readonly dummyConfig?: {
    readonly email?: string
    readonly sub?: string
    readonly name?: string
  }
  /**
   * OAuth clients that are allowed to use this issuer.
   * These are merged with any clients loaded from the database.
   * Required for local development (e.g., graphql-api).
   */
  readonly clients?: readonly IssuerClient[]
}

export interface CreateClientJwtOptions {
  readonly clientId: string
  readonly issuerUrl: string
  readonly audience: string
  readonly issuedAtUnixSeconds?: number
}

/**
 * Result of createAuthenticationServer containing both the app and runtime.
 * The runtime must be used when handling requests as it contains all required services.
 */
export interface AuthenticationServerResult {
  /**
   * The HTTP app (issuer) that handles OAuth requests.
   */
  readonly app: Issuer
  /**
   * Runtime with all services required by the app's request handlers.
   * Use this with HttpApp.toWebHandlerRuntime(runtime)(app) to handle requests.
   */
  readonly runtime: Runtime.Runtime<never>
}

/**
 * Create the authentication server issuer
 *
 * Loads OAuth provider configurations from the database and creates an OpenAuth issuer.
 * Supports 15 OAuth2 providers: google, github, microsoft, apple, discord, spotify,
 * slack, linkedin, twitch, yahoo, x, keycloak, cognito, jumpcloud, facebook.
 *
 * When `dummyConfig` option is set (and NODE_ENV is not production), uses a
 * dummy provider that auto-completes OAuth flow for testing purposes.
 *
 * Returns both the app and a runtime that contains all required services.
 * The runtime must be used when handling requests:
 * ```ts
 * const { app, runtime } = yield* createAuthenticationServer(options)
 * const handler = HttpApp.toWebHandlerRuntime(runtime)(app)
 * ```
 *
 * @param options - Optional configuration for the authentication server
 * @returns Effect that creates and returns the issuer app and runtime
 */
export const createAuthenticationServer = (
  options?: CreateAuthenticationServerOptions,
): Effect.Effect<
  AuthenticationServerResult,
  | ProviderConfigurationError
  | InvalidProviderConfigError
  | ProviderUserAuthenticationError
  | ResolveIssuerClientsError
  | ClientRegistryError,
  | AuthenticationDatabase
  | HttpClient.HttpClient
  | StorageService
  | SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    // Get the database to load OAuth providers
    const authDb = yield* AuthenticationDatabase
    const frontendClientId = getClientId()
    const delegationSessions = yield* Effect.serviceOption(
      DelegationSessionService,
    )
    const authenticationDatabaseLayer = Layer.succeed(
      AuthenticationDatabase,
      authDb,
    )

    // Get storage service from context
    const storage = yield* StorageServiceTag

    // Capture the SqlClient instance from context so we can provide it to callbacks
    const sql = yield* SqlClient.SqlClient
    const callbackRuntime = yield* Effect.runtime<
      AuthenticationDatabase | StorageService
    >()

    // Build providers object - only dummy provider is loaded eagerly
    // All other providers are loaded lazily via resolveProvider callback
    const staticProviders: Record<
      string,
      Oauth2Provider | Provider<PasskeyProperties> | Provider<DummyProperties>
    > = {}

    // Check if dummy provider should be used (bypasses database)
    if (options?.dummyConfig) {
      if (!isDummyProviderAllowed()) {
        return yield* new ProviderConfigurationError({
          message:
            "Dummy provider is only allowed in non-production environments",
        })
      }
      staticProviders["dummy"] = DummyProvider(options.dummyConfig)
      yield* Effect.logWarning(
        "Dummy provider enabled - only use for testing/development",
      )
    }

    // Resolve clients from options and environment
    const configuredClients = yield* resolveIssuerClients([
      ...(options?.clients ?? []),
    ])
    if (configuredClients.length === 0) {
      yield* Effect.logWarning(
        "No static OAuth clients configured — clients will be resolved from database at runtime",
      )
    }

    /**
     * Lazily resolve OAuth providers from database on first request.
     * The resolved provider is cached by OpenAuth issuer for server lifetime.
     * Returns Effect directly - issuer runs this Effect internally.
     */
    const resolveProvider = options?.dummyConfig
      ? undefined
      : (name: string) =>
          Effect.gen(function* () {
            const maybeRecord = yield* authDb.findOAuthProviderByName(name)
            if (Option.isNone(maybeRecord)) return undefined

            const record = maybeRecord.value

            // Handle passkey provider separately (different config shape)
            if (name === "passkey") {
              const passkeyConfig = yield* Schema.decodeUnknown(
                PasskeyConfigSchema,
              )(record.config).pipe(
                Effect.catchAll((cause) => {
                  return Effect.gen(function* () {
                    yield* Effect.logError(
                      `Failed to validate passkey config`,
                    ).pipe(Effect.annotateLogs({ cause }))
                    return undefined
                  })
                }),
              )
              if (!passkeyConfig) return undefined

              yield* Effect.log(`Loaded OAuth provider 'passkey' from database`)
              const providerConfig: PasskeyConfig = {
                rpName: passkeyConfig.rpName,
                rpID: passkeyConfig.rpID,
                origin: passkeyConfig.origin as string | string[],
                canRegister: async (email) => {
                  const runPromise = Runtime.runPromise(callbackRuntime)
                  // Open Registration only: revalidates inviteOnly, no existing
                  // Provider User, and no pending Invitation with one public error.
                  return runPromise(
                    authorizePasskeyOpenRegistration(email).pipe(
                      Effect.provideService(AuthenticationDatabase, authDb),
                      Effect.matchEffect({
                        onFailure: (error) =>
                          Effect.gen(function* () {
                            if (
                              error instanceof
                              PasskeyOpenRegistrationDeniedError
                            ) {
                              yield* Effect.logWarning(
                                "Passkey Open Registration denied at options",
                              ).pipe(
                                Effect.annotateLogs({ email: error.email }),
                              )
                            } else {
                              yield* Effect.logError(
                                "Passkey Open Registration eligibility check failed",
                              ).pipe(
                                Effect.annotateLogs({
                                  email,
                                  error: formatUnknownError(error),
                                }),
                              )
                            }
                            return {
                              allowed: false as const,
                              error: OPEN_REGISTRATION_DENIED_MESSAGE,
                            }
                          }),
                        onSuccess: () =>
                          Effect.succeed({ allowed: true as const }),
                      }),
                    ),
                  )
                },
                exchangeRegistrationLink: async (token) => {
                  const runPromise = Runtime.runPromise(callbackRuntime)
                  return runPromise(
                    Effect.gen(function* () {
                      return isPasskeyRecoveryLink(token)
                        ? yield* exchangePasskeyRecoveryLink(token)
                        : yield* authDb.exchangeRegistrationLink(token)
                    }).pipe(
                      Effect.map((result) => {
                        if (Option.isNone(result)) {
                          return {
                            ok: false as const,
                            error: INVITATION_REGISTRATION_INVALID_MESSAGE,
                          }
                        }
                        return {
                          ok: true as const,
                          email: result.value.email,
                          sessionBearer: result.value.sessionBearer,
                          expiresAtUnixMs: DateTime.toEpochMillis(
                            result.value.expiresAt,
                          ),
                        }
                      }),
                      Effect.catchAll((error) =>
                        Effect.gen(function* () {
                          yield* Effect.logError(
                            "Registration Link exchange failed",
                          ).pipe(
                            Effect.annotateLogs({
                              error: formatUnknownError(error),
                            }),
                          )
                          return {
                            ok: false as const,
                            error: INVITATION_REGISTRATION_INVALID_MESSAGE,
                          }
                        }),
                      ),
                    ),
                  )
                },
                resolveInvitationRegistrationSession: async (sessionBearer) => {
                  const runPromise = Runtime.runPromise(callbackRuntime)
                  if (isPasskeyRecoverySession(sessionBearer)) {
                    return runPromise(
                      resolvePasskeyRecoverySession(sessionBearer).pipe(
                        Effect.map((result) =>
                          Option.isNone(result)
                            ? {
                                allowed: false as const,
                                error: INVITATION_REGISTRATION_INVALID_MESSAGE,
                              }
                            : {
                                allowed: true as const,
                                context: {
                                  registrationKind: "recovery" as const,
                                  email: result.value.email,
                                  userId: result.value.userId,
                                  userHandle: result.value.userHandle,
                                  recoveryId: result.value.recoveryId,
                                  sessionTokenHash:
                                    hashPasskeyRecoveryBearer(sessionBearer),
                                },
                              },
                        ),
                        Effect.orElseSucceed(() => ({
                          allowed: false as const,
                          error: INVITATION_REGISTRATION_INVALID_MESSAGE,
                        })),
                      ),
                    )
                  }
                  return runPromise(
                    authDb
                      .resolveInvitationRegistrationSession(sessionBearer)
                      .pipe(
                        Effect.map((result) => {
                          if (Option.isNone(result)) {
                            return {
                              allowed: false as const,
                              error: INVITATION_REGISTRATION_INVALID_MESSAGE,
                            }
                          }
                          return {
                            allowed: true as const,
                            context: {
                              registrationKind: "invitation" as const,
                              email: result.value.email,
                              invitationId: result.value.invitationId,
                              linkGeneration: result.value.linkGeneration,
                              sessionTokenHash: result.value.sessionTokenHash,
                            },
                          }
                        }),
                        Effect.catchAll((error) =>
                          Effect.gen(function* () {
                            yield* Effect.logError(
                              "Registration Session resolve failed",
                            ).pipe(
                              Effect.annotateLogs({
                                error: formatUnknownError(error),
                              }),
                            )
                            return {
                              allowed: false as const,
                              error: INVITATION_REGISTRATION_INVALID_MESSAGE,
                            }
                          }),
                        ),
                      ),
                  )
                },
                findCredential: async (credentialId) => {
                  const runPromise = Runtime.runPromise(callbackRuntime)
                  return runPromise(
                    authDb.findPasskeyCredentialById(credentialId).pipe(
                      Effect.map((credential) =>
                        Option.isSome(credential)
                          ? {
                              ...credential.value,
                              userHandle: getPasskeyUserHandle(
                                credential.value,
                              ),
                            }
                          : undefined,
                      ),
                      Effect.catchAll((error) =>
                        Effect.gen(function* () {
                          yield* Effect.logError(
                            "Passkey findCredential failed",
                          ).pipe(
                            Effect.annotateLogs({
                              credentialId,
                              error: formatUnknownError(error),
                            }),
                          )
                          return undefined
                        }),
                      ),
                    ),
                  )
                },
              }

              return PasskeyProvider(providerConfig)
            }

            const factory = providerFactories[name]
            if (!factory) {
              yield* Effect.logWarning(`Unsupported provider '${name}'`)
              return undefined
            }

            const validatedConfig = yield* Schema.decodeUnknown(
              Oauth2WrappedConfigSchema,
            )(record.config).pipe(
              Effect.catchAll((cause) => {
                return Effect.gen(function* () {
                  yield* Effect.logError(
                    `Failed to validate config for provider '${name}'`,
                  ).pipe(Effect.annotateLogs({ cause }))
                  return undefined
                })
              }),
            )
            if (!validatedConfig) return undefined
            if (!hasRequiredProviderConfig(name, validatedConfig)) {
              yield* Effect.logError(
                `Provider '${name}' is missing required configuration`,
              )
              return undefined
            }

            yield* Effect.log(`Loaded OAuth provider '${name}' from database`)
            return factory(validatedConfig as Oauth2WrappedConfig)
          }).pipe(
            Effect.withSpan(`auth.resolveProvider.${name}`),
            Effect.catchAll((e) =>
              Effect.logError(`Failed to load provider '${name}'`, e).pipe(
                Effect.annotateLogs({ provider: name }),
                Effect.as(undefined),
              ),
            ),
            Effect.provide(authenticationDatabaseLayer),
          )

    /**
     * List all OAuth providers from database.
     */
    const listProviders = options?.dummyConfig
      ? undefined
      : () =>
          Effect.gen(function* () {
            const records = yield* authDb.findAllOAuthProviders()
            return records.map((r) => r.name)
          }).pipe(
            Effect.withSpan("auth.listProviders"),
            Effect.provide(authenticationDatabaseLayer),
            Effect.catchAll((error) =>
              Effect.gen(function* () {
                yield* Effect.logError(
                  "Failed to list OAuth providers from database",
                ).pipe(Effect.annotateLogs({ error }))
                return [] as readonly string[]
              }),
            ),
          )

    /**
     * Resolve OAuth client from database.
     */
    const resolveClient = (clientId: string) =>
      Effect.gen(function* () {
        const maybeClient = yield* authDb.findOAuthClientById(clientId)
        if (Option.isNone(maybeClient)) return undefined
        const client = maybeClient.value
        return {
          id: client.clientId,
          redirectUris: [] as string[],
          secretHash: client.secretHash,
          audience: client.audience,
        }
      }).pipe(
        Effect.withSpan("auth.resolveClient"),
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            yield* Effect.logError(
              "Failed to lookup OAuth client from database",
            ).pipe(Effect.annotateLogs({ clientId, error }))
            return undefined
          }),
        ),
        Effect.provide(authenticationDatabaseLayer),
      )

    // Build service layers
    const storageLayer = Layer.succeed(StorageServiceTag, storage)

    const keyMgmtLayer = KeyManagementServiceLive.pipe(
      Layer.provide(storageLayer),
    )

    const encryptionLayer = EncryptionServiceLive.pipe(
      Layer.provide(keyMgmtLayer),
    )

    const cookieAuthLayer = CookieAuthServiceLive.pipe(
      Layer.provide(encryptionLayer),
      Layer.provide(storageLayer),
    )

    const clientRegistryLayer = makeClientRegistryService(
      configuredClients,
      resolveClient,
    )

    const isPasskeyOpenRegistration = options?.dummyConfig
      ? undefined
      : () =>
          Effect.gen(function* () {
            const inviteOnly = yield* resolveInviteOnlyForProvider("passkey")
            return !inviteOnly
          }).pipe(
            Effect.withSpan("auth.isPasskeyOpenRegistration"),
            Effect.provideService(AuthenticationDatabase, authDb),
            Effect.catchAll((error) =>
              Effect.gen(function* () {
                yield* Effect.logError(
                  "Failed to resolve passkey Open Registration availability",
                ).pipe(Effect.annotateLogs({ error }))
                // Fail closed: hide self-registration when config is unknown.
                return false
              }),
            ),
          )

    const providerRegistryLayer = makeProviderRegistryService(
      staticProviders,
      listProviders,
      resolveProvider,
      isPasskeyOpenRegistration,
    )

    const ttlConfigLayer = makeTokenTtlConfig({
      ...defaultTokenTtl,
      refresh: 60 * 60 * 24 * 90, // 90 days
    })

    const subjectsConfigLayer = makeSubjectsConfig(subjects)

    // Build the callbacks layer with all the application-specific logic
    const callbacksLayer = makeIssuerCallbacks<ProviderResult>({
      resolveSubject: defaultResolveSubject,
      start: undefined,
      onRefresh: ({ type, properties, scope, clientId }) =>
        Effect.gen(function* () {
          if (!("delegation" in properties)) return { properties }
          if (type !== "providerUser" || Option.isNone(delegationSessions))
            return yield* new OnRefreshScopeError({
              message: "Delegated access unavailable",
            })
          const parsed = yield* Effect.promise(async () =>
            subjects.providerUser["~standard"].validate(properties),
          )
          if (parsed.issues)
            return yield* new OnRefreshScopeError({
              message: "Invalid delegated session",
            })
          const scopeParts = scope?.split(/\s+/).filter(Boolean) ?? []
          const cli = scopeParts.includes("cli")
          if (
            (cli && clientId !== frontendClientId) ||
            scopeParts.some(
              (part) => part !== "cli" && !part.startsWith("role:"),
            )
          )
            return yield* new OnRefreshScopeError({
              message: "Delegated handoff unavailable",
            })
          const session = yield* delegationSessions.value.check({
            ...parsed.value,
            ...(scopeParts.length > 0 && !cli
              ? { delegationRoleSelection: undefined }
              : {}),
          })
          return { properties: session }
        }).pipe(
          Effect.mapError(
            () =>
              new OnRefreshScopeError({ message: "Invalid delegated session" }),
          ),
        ),
      onRefreshScope: ({ userId, clientId, scope, currentProperties }) =>
        Effect.gen(function* () {
          // Parse scope parts
          const scopeParts = scope.split(/\s+/)
          // CLI export keeps the live session and selected roles, including delegation.
          // It takes priority over role switching; the issuer still caps its TTL.
          if (scopeParts.includes("cli")) {
            if (clientId !== frontendClientId) {
              yield* Effect.logWarning(
                "cli scope rejected for non-frontend client",
              ).pipe(Effect.annotateLogs({ clientId }))
              return yield* new OnRefreshScopeError({
                message: "cli scope is only allowed for frontend client",
              })
            }
            if (scopeParts.some((p) => p.startsWith("role:"))) {
              yield* Effect.logWarning(
                "role: scopes ignored when cli scope is present",
              ).pipe(Effect.annotateLogs({ userId, scope }))
            }
            return {
              properties: currentProperties,
              accessTokenTtl: 8 * 60 * 60,
            }
          }
          if ("delegation" in currentProperties) {
            const parsed = yield* Effect.promise(async () =>
              subjects.providerUser["~standard"].validate(currentProperties),
            )
            if (parsed.issues || Option.isNone(delegationSessions))
              return yield* new OnRefreshScopeError({
                message: "Invalid delegated session",
              })
            const session = yield* delegationSessions.value.check({
              ...parsed.value,
              delegationRoleSelection: undefined,
            })
            const roles = yield* Effect.try(() =>
              scopeParts.map((part) =>
                part.startsWith("role:")
                  ? decodeURIComponent(part.slice(5))
                  : "",
              ),
            )
            if (roles.some((role) => !role || !session.roles.includes(role)))
              return yield* new OnRefreshScopeError({
                message: "Invalid delegated role scope",
              })
            return {
              properties: { ...session, roles, delegationRoleSelection: roles },
            }
          }

          // Parse role scopes from the scope parameter
          // Format: "role:RolePath role:AnotherRolePath"
          // Role paths are URL-encoded to handle spaces (OAuth2 uses space as scope delimiter)
          const requestedRoles: string[] = []
          for (const part of scopeParts) {
            if (part.startsWith("role:")) {
              requestedRoles.push(decodeURIComponent(part.slice(5)))
            }
          }

          if (requestedRoles.length === 0) {
            // No recognized scopes requested, return current properties unchanged
            return { properties: currentProperties }
          }

          // First, check if these roles are in employee_role table
          const providerUserRoles = yield* authDb.findProviderUserRoles(userId)
          const providerUserRoleSet = new Set(providerUserRoles)

          // Then check permitted_role table for roles not in employee_role
          // This also returns org unit info for each permitted role
          const permittedRolesWithOrgUnit =
            yield* authDb.findPermittedRolesWithOrgUnit(userId)
          const permittedRoleMap = new Map(
            permittedRolesWithOrgUnit.map((r) => [r.rolePath, r]),
          )

          // Validate all requested roles
          const invalidRoles = requestedRoles.filter(
            (r) => !providerUserRoleSet.has(r) && !permittedRoleMap.has(r),
          )

          if (invalidRoles.length > 0) {
            yield* Effect.logWarning("User requested invalid role scopes").pipe(
              Effect.annotateLogs({
                userId,
                requestedRoles,
                invalidRoles,
                providerUserRoles,
                permittedRoles: [...permittedRoleMap.keys()],
              }),
            )
            return yield* new OnRefreshScopeError({
              message: "User requested invalid role scopes",
              cause: new InvalidRoleScopeError({
                invalidRoles,
                requestedRoles,
                userId,
              }),
            })
          }

          // Determine org unit context based on the first requested role
          // If the first role is from employee_role, use the employee's org unit
          // If the first role is from permitted_role (not in employee_role), use that role's org unit
          const firstRole = requestedRoles[0]
          // Safety: requestedRoles.length > 0 is guaranteed by early return above
          if (firstRole === undefined) {
            return yield* new OnRefreshScopeError({
              message: "requestedRoles is non-empty but firstRole is undefined",
              cause: new InvariantViolationError({
                message:
                  "requestedRoles is non-empty but firstRole is undefined",
              }),
            })
          }
          const isProviderUserRole = providerUserRoleSet.has(firstRole)
          const permittedRole = !isProviderUserRole
            ? permittedRoleMap.get(firstRole)
            : undefined

          let orgUnitId: string | undefined
          let orgUnitPath: string | undefined

          if (permittedRole) {
            // Switching to a permitted role - use that role's org unit
            orgUnitId = permittedRole.orgUnitId
            orgUnitPath = permittedRole.orgUnitPath
          } else {
            // Switching to own role - look up provider user's org unit from database
            const employeeOption =
              yield* authDb.findProviderUserByUserId(userId)
            if (Option.isSome(employeeOption)) {
              orgUnitId = employeeOption.value.orgUnitId
              orgUnitPath = employeeOption.value.orgUnitPath
            } else {
              // Fallback to current properties if provider user not found
              orgUnitId = currentProperties["orgUnitId"] as string | undefined
              orgUnitPath = currentProperties["orgUnitPath"] as
                | string
                | undefined
            }
          }

          yield* Effect.log("User switching roles").pipe(
            Effect.annotateLogs({
              userId,
              requestedRoles,
              orgUnitId,
              orgUnitPath,
            }),
          )

          // Return properties with the requested roles and updated org unit
          return {
            properties: {
              ...currentProperties,
              roles: requestedRoles,
              orgUnitId,
              orgUnitPath,
            },
          }
        }).pipe(
          Effect.mapError((error) =>
            error instanceof OnRefreshScopeError
              ? error
              : new OnRefreshScopeError({
                  message: "Failed to process scope request",
                  cause: error,
                }),
          ),
          Effect.withSpan("auth.onRefreshScope"),
          Effect.provide(authenticationDatabaseLayer),
        ),

      allow: (input: AllowCallbackInput, _req) =>
        Effect.gen(function* () {
          // For now, use simple redirect URI validation against configured clients
          // This could be extended to check database for dynamic clients
          const clientRegistry = yield* Effect.serviceOption(
            ClientRegistryService,
          )
          if (Option.isNone(clientRegistry)) {
            // Fallback: just check that we have a client ID
            return !!input.clientID
          }
          const client = clientRegistry.value.staticClients.get(input.clientID)
          if (!client) {
            return false
          }
          return isValidRedirectUri(input.redirectURI, [...client.redirectUris])
        }).pipe(Effect.orElseSucceed(() => true)),

      success: (ctx, input, _req) =>
        Effect.gen(function* () {
          // Wrap entire success handler in a transaction for data consistency
          // All database operations happen within the transaction, but the
          // ctx.subject() call (which creates the HTTP response) happens after
          // the transaction commits to avoid holding the connection.
          // Non-critical updates such as updateLastLoggedIn retry at their
          // provider-user-auth and passkey-auth call sites, so the whole
          // transaction is not retried.
          const subjectData = yield* sql.withTransaction(
            Effect.gen(function* () {
              // Passkey authentication (no tokenset, has userId directly)
              if (input.provider === "passkey") {
                // Safe cast: discriminant checked above
                return yield* handlePasskeySuccess(
                  input as PasskeyProperties & { provider: "passkey" },
                )
              }

              // M2M client credentials authentication (no user, just client)
              if (input.provider === "credentials") {
                // Safe cast: discriminant checked above
                return yield* handleConfidentialClientSuccess(
                  input as CredentialsValue,
                )
              }

              // OAuth authentication (Google, GitHub, etc. and dummy provider)
              // Safe cast: passkey and credentials ruled out above
              return yield* handleOauth2Success(
                input as
                  | Oauth2Value
                  | VerifiedHumanIdentity
                  | ProviderSubjectIdentity,
              )
            }),
          )

          // Create the subject token after the transaction commits
          // subjectData is either { type, properties } or a Response (for errors)
          if (subjectData instanceof Response) {
            return HttpServerResponse.fromWeb(subjectData)
          }
          return yield* ctx.subject(subjectData.type, subjectData.properties)
        }).pipe(
          Effect.withSpan("auth.success"),
          Effect.provideService(AuthenticationDatabase, authDb),
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.catchTags({
            "@pf/InviteRequiredError": (error: InviteRequiredError) =>
              Effect.gen(function* () {
                yield* Effect.logWarning(
                  "Authentication blocked: invite required",
                ).pipe(Effect.annotateLogs({ email: error.email }))
                // Same public copy as missing verified identity: do not disclose which gate failed.
                return yield* ctx.error(
                  "access_denied",
                  "Unable to complete sign-in",
                )
              }),
            "@pf/PasskeyOpenRegistrationDeniedError": (
              error: PasskeyOpenRegistrationDeniedError,
            ) =>
              Effect.gen(function* () {
                yield* Effect.logWarning(
                  "Passkey Open Registration denied",
                ).pipe(Effect.annotateLogs({ email: error.email }))
                return yield* ctx.error(
                  "access_denied",
                  OPEN_REGISTRATION_DENIED_MESSAGE,
                )
              }),
            "@pf/PasskeyInvitationRegistrationDeniedError": (
              error: PasskeyInvitationRegistrationDeniedError,
            ) =>
              Effect.gen(function* () {
                yield* Effect.logWarning(
                  "Passkey Invitation registration denied",
                ).pipe(Effect.annotateLogs({ reason: error.reason }))
                return yield* ctx.error(
                  "access_denied",
                  INVITATION_REGISTRATION_INVALID_MESSAGE,
                )
              }),
            "@pf/ProviderUserEmailAlreadyOwnedError": (
              error: ProviderUserEmailAlreadyOwnedError,
            ) =>
              Effect.gen(function* () {
                yield* Effect.logWarning(
                  "Authentication blocked: email already owned",
                ).pipe(
                  Effect.annotateLogs({
                    email: error.email,
                    provider: error.provider,
                    sub: error.subject,
                    existingProvider: error.existingProvider,
                    existingSub: error.existingSubject,
                  }),
                )
                return yield* ctx.error(
                  "access_denied",
                  "An account already owns this email address",
                )
              }),
            "@pf/PasskeyCredentialAlreadyOwnedError": (
              error: PasskeyCredentialAlreadyOwnedError,
            ) =>
              Effect.gen(function* () {
                yield* Effect.logWarning(
                  "Passkey registration blocked: credential already owned",
                ).pipe(
                  Effect.annotateLogs({ credentialId: error.credentialId }),
                )
                return yield* ctx.error(
                  "access_denied",
                  "This passkey is already registered",
                )
              }),
            "@pf/PasskeyIdentityNotFoundError": (
              error: PasskeyIdentityNotFoundError,
            ) =>
              Effect.gen(function* () {
                yield* Effect.logWarning(
                  "Passkey authentication rejected",
                ).pipe(Effect.annotateLogs({ error }))
                return yield* ctx.error(
                  "access_denied",
                  "Passkey authentication failed",
                )
              }),
            "@pf/PasskeyCounterError": (error: PasskeyCounterError) =>
              Effect.gen(function* () {
                yield* Effect.logWarning(
                  "Passkey authentication rejected",
                ).pipe(Effect.annotateLogs({ error }))
                return yield* ctx.error(
                  "access_denied",
                  "Passkey authentication failed",
                )
              }),
            "@pf/DummyProviderUserNotFoundError": (
              error: DummyProviderUserNotFoundError,
            ) =>
              Effect.gen(function* () {
                yield* Effect.logWarning(
                  "Authentication blocked: dummy login requires existing user",
                ).pipe(Effect.annotateLogs({ email: error.email }))
                return yield* ctx.error(
                  "access_denied",
                  `Dummy login requires an existing user, but the given bypass user ${error.email} does not exist in the database. Please set PF_BYPASS_AUTH to a valid user.`,
                )
              }),
            "@pf/VerifiedEmailRequiredError": (
              error: VerifiedEmailRequiredError,
            ) =>
              Effect.gen(function* () {
                yield* Effect.logWarning(
                  "Authentication blocked: verified email required",
                ).pipe(
                  Effect.annotateLogs({
                    provider: error.provider,
                    sub: error.subject,
                  }),
                )
                // Same public copy as missing Invitation: do not disclose which gate failed.
                return yield* ctx.error(
                  "access_denied",
                  "Unable to complete sign-in",
                )
              }),
          }),
          // Catch non-interface errors (like database errors) and convert to error response
          // Interface errors (HttpBodyError, StorageError, MissingHostError) pass through
          Effect.catchAllCause((cause) =>
            Effect.gen(function* () {
              yield* Effect.logError(
                "Authentication success handler failed unexpectedly",
              ).pipe(Effect.annotateLogs({ cause }))
              return HttpServerResponse.text("Authentication failed", {
                status: 500,
              })
            }),
          ),
        ),
    })

    // Combine all layers
    const allLayers = Layer.mergeAll(
      storageLayer,
      keyMgmtLayer,
      encryptionLayer,
      cookieAuthLayer,
      clientRegistryLayer,
      providerRegistryLayer,
      ttlConfigLayer,
      subjectsConfigLayer,
      callbacksLayer,
    )

    // Provide all auth services and build the issuer app
    // Both app and runtime are created within the provided context, so the runtime
    // captures auth services AND outer context (OTEL, storage, etc.)
    return yield* Effect.gen(function* () {
      const oauthApp = yield* issuer
      const delegationApp = yield* makeDelegationManagementHandler
      const passkeyManagementApp = yield* makePasskeyManagementHandler
      const delegationExchange = yield* makeDelegationExchangeHandler
      const app: Issuer = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const pathname = new URL(request.url, "http://localhost").pathname
        if (
          pathname === "/oauth/delegation" ||
          pathname === "/oauth/delegation/availability" ||
          pathname === "/oauth/delegation/session"
        )
          return yield* delegationExchange
        if (pathname === "/delegations") return yield* delegationApp
        if (pathname === "/passkeys") return yield* passkeyManagementApp
        return yield* oauthApp
      })
      const runtime = yield* Effect.runtime<never>()
      return { app, runtime } satisfies AuthenticationServerResult
    }).pipe(Effect.provide(allLayers))
  })

/** Default client ID used for the frontend JWT token. */
export const FRONTEND_CLIENT_ID = "frontend"

export const createClientJwt = (
  options: CreateClientJwtOptions,
): Effect.Effect<
  string,
  ClientJwtMintError | FrontendJwtCreateError,
  StorageService
> =>
  Effect.gen(function* () {
    if (options.clientId.trim().length === 0) {
      return yield* new ClientJwtMintError({
        message: "clientId must not be empty",
      })
    }

    const normalizedIssuer = stripTrailingSlash(options.issuerUrl)

    yield* Effect.try({
      try: () => new URL(normalizedIssuer),
      catch: () =>
        new ClientJwtMintError({
          message: `Invalid issuer URL: ${options.issuerUrl}`,
        }),
    })

    return yield* createFrontendJwt(
      options.clientId,
      normalizedIssuer,
      options.audience,
      options.issuedAtUnixSeconds ?? Math.floor(Date.now() / 1000),
    ).pipe(Effect.provide(KeyManagementServiceLive))
  })

export const storeFrontendJwt = (
  clientId: string,
  token: string,
): Effect.Effect<void, StorageError, StorageServiceTag> =>
  Storage.set(["frontend-jwt", clientId], { token })

export const readFrontendJwt = (
  clientId: string,
): Effect.Effect<string | undefined, StorageError, StorageServiceTag> =>
  Storage.get<{ token: string }>(["frontend-jwt", clientId]).pipe(
    Effect.map((result) => result?.token),
  )
