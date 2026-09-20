/**
 * Provider interface for OpenAuth authentication providers.
 *
 * Providers are authentication backends (OAuth2, OIDC, Passkey, etc.)
 * that handle the actual user authentication flow.
 *
 * @packageDocumentation
 */
import type {
  HttpBody,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform"
import { Data, Effect } from "effect"
import isEmail from "validator/lib/isEmail"
import type {
  InvariantViolationError,
  MissingHostError,
  OAuthEndpointError,
} from "../endpoints/errors.js"
import type {
  KeyManagementService,
  NoEncryptionKeysError,
  NoSigningKeysError,
} from "../services/key-management.js"
import type { StorageError, StorageService } from "../storage/storage.js"

export type { StorageError }

/**
 * Failure from a consumer-supplied provider callback (UI renderer, sendCode,
 * hasher, credential lookup, etc.).
 *
 * These are expected operational failures (e.g. transient SMTP) and must not
 * become Effect defects.
 */
export class ProviderCallbackError extends Data.TaggedError(
  "@pf/openauth/ProviderCallbackError",
)<{
  readonly message: string
  readonly cause: unknown
}> {}

/**
 * Run a consumer-supplied promise callback as a typed failure.
 */
export const tryProviderCallback = <A>(
  message: string,
  tryFn: () => Promise<A>,
): Effect.Effect<A, ProviderCallbackError> =>
  Effect.tryPromise({
    try: tryFn,
    catch: (cause) => new ProviderCallbackError({ message, cause }),
  })

export type NormalizedEmail = string & {
  readonly NormalizedEmail: unique symbol
}

export interface VerifiedHumanIdentity {
  readonly type: "verified-human-identity"
  readonly provider: string
  readonly subject: string
  readonly email: NormalizedEmail
  readonly profile: {
    readonly name: string
    readonly givenName?: string
    readonly familyName?: string
    readonly picture?: string
    readonly locale?: string
  }
  readonly emailVerification: {
    readonly method: "oidc-claim" | "provider-api"
    readonly claim: string
    readonly verified: true
  }
}

/**
 * Stable provider subject only. Existing Provider Users may continue with this
 * when verified-email evidence is unavailable; first-user creation must not.
 */
export interface ProviderSubjectIdentity {
  readonly type: "provider-subject-identity"
  readonly provider: string
  readonly subject: string
  readonly picture?: string
}

/** Validate and normalize an email at a human identity provider boundary. */
export const normalizeEmail = (email: unknown): NormalizedEmail | undefined => {
  if (typeof email !== "string") return undefined

  const normalized = email.trim().toLowerCase()
  return isEmail(normalized, {
    require_tld: false,
    allow_utf8_local_part: true,
    allow_ip_domain: true,
  })
    ? (normalized as NormalizedEmail)
    : undefined
}

/** Build a verified identity from protocol-verified OIDC claims. */
export const verifiedOidcIdentity = (
  provider: string,
  payload: Record<string, unknown>,
): VerifiedHumanIdentity | undefined => {
  const email = normalizeEmail(payload["email"])
  const subject = payload["sub"]
  if (
    payload["email_verified"] !== true ||
    !email ||
    typeof subject !== "string" ||
    subject.length === 0
  ) {
    return undefined
  }

  const stringClaim = (claim: string): string | undefined =>
    typeof payload[claim] === "string" ? payload[claim] : undefined
  const givenName = stringClaim("given_name")
  const familyName = stringClaim("family_name")
  const picture = stringClaim("picture")
  const locale = stringClaim("locale")

  return {
    type: "verified-human-identity",
    provider,
    subject,
    email,
    profile: {
      name: stringClaim("name") ?? email,
      ...(givenName ? { givenName } : {}),
      ...(familyName ? { familyName } : {}),
      ...(picture ? { picture } : {}),
      ...(locale ? { locale } : {}),
    },
    emailVerification: {
      method: "oidc-claim",
      claim: "email_verified",
      verified: true,
    },
  }
}

/**
 * Context provided to provider route handlers.
 * This is passed via Effect context, not as function arguments.
 */
export interface ProviderContext {
  /** The provider name (e.g., "google", "github") */
  readonly name: string
}

/**
 * Options passed to provider init function.
 * Storage is accessed via StorageService from Effect context.
 */
export interface ProviderOptions<Properties> {
  /** The provider name */
  readonly name: string
  /**
   * Called when authentication succeeds.
   * Returns an HttpServerResponse (typically a redirect with auth code).
   * May require KeyManagementService when generating tokens directly.
   */
  readonly success: (
    properties: Properties,
    opts?: {
      invalidate?: (subject: string) => Promise<void>
    },
  ) => Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    | HttpBody.HttpBodyError
    | StorageError
    | MissingHostError
    | OAuthEndpointError
    | NoSigningKeysError
    | NoEncryptionKeysError
    | InvariantViolationError,
    HttpServerRequest.HttpServerRequest | StorageService | KeyManagementService
  >
  /**
   * Store encrypted state in a cookie.
   * Returns the Set-Cookie header value.
   */
  readonly setCookie: (
    key: string,
    maxAge: number,
    value: unknown,
  ) => Effect.Effect<
    string,
    StorageError | NoEncryptionKeysError,
    HttpServerRequest.HttpServerRequest
  >
  /**
   * Get decrypted state from a cookie.
   */
  readonly getCookie: <T>(
    key: string,
  ) => Effect.Effect<
    T | undefined,
    StorageError | NoEncryptionKeysError,
    HttpServerRequest.HttpServerRequest
  >
  /**
   * Delete a cookie.
   * Returns the Set-Cookie header value.
   */
  readonly deleteCookie: (key: string) => Effect.Effect<string>
  /**
   * Invalidate all refresh tokens for a subject.
   * Used when password is changed to force re-authentication.
   */
  readonly invalidate: (subject: string) => Effect.Effect<void, StorageError>
}

/**
 * Provider interface.
 *
 * A provider creates an HttpRouter that handles the OAuth flow:
 * - GET /authorize: Start the auth flow
 * - GET/POST /callback: Handle the callback from the IdP
 *
 * Providers access StorageService via Effect context when needed.
 */
export interface Provider<Properties = unknown> {
  /** Provider type identifier (e.g., "oauth2", "oidc", "passkey") */
  readonly type: string
  /**
   * Initialize the provider and return an HttpRouter.
   * The router handles routes relative to /oauth/{provider-name}/
   * Storage is available via StorageService from Effect context.
   * KeyManagementService may be required for token generation.
   */
  readonly init: (
    options: ProviderOptions<Properties>,
  ) => HttpRouter.HttpRouter<
    | HttpBody.HttpBodyError
    | StorageError
    | MissingHostError
    | OAuthEndpointError
    | NoSigningKeysError
    | NoEncryptionKeysError
    | InvariantViolationError
    | ProviderCallbackError,
    HttpServerRequest.HttpServerRequest | StorageService | KeyManagementService
  >
  /**
   * Optional: Handle client credentials flow for M2M authentication.
   */
  readonly client?: (input: {
    clientID: string
    clientSecret: string
    params: Record<string, string>
  }) => Promise<Properties>
}

export class ProviderError extends Error {}
export class ProviderUnknownError extends ProviderError {}
