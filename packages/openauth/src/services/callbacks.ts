/**
 * Issuer callbacks service for customizable authentication behavior.
 * These callbacks are provided by the consuming application.
 * @packageDocumentation
 */
import type {
  HttpBody,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform"
import { Context, Data, Effect, Layer } from "effect"
import type {
  InvariantViolationError,
  MissingHostError,
  OAuthEndpointError,
} from "../endpoints/errors"
import type {
  AllowCallbackInput,
  OnRefreshScopeInput,
  OnRefreshScopeResult,
  OnSuccessResponder,
} from "../endpoints/types"
import type { StorageError, StorageService } from "../storage/storage"
import type { KeyManagementService, NoSigningKeysError } from "./key-management"

/**
 * Expected failure from the onRefreshScope callback.
 * Issuer converts this to a client-safe invalid_scope response; do not put
 * sensitive or SQL detail in `message`.
 */
export class OnRefreshScopeError extends Data.TaggedError(
  "@pf/openauth/OnRefreshScopeError",
)<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Error types that can be returned by the success callback.
 */
export type SuccessCallbackError =
  | HttpBody.HttpBodyError
  | StorageError
  | MissingHostError
  | OAuthEndpointError
  | NoSigningKeysError
  | InvariantViolationError

/**
 * Callbacks interface for issuer customization.
 *
 * @typeParam Success - The type of the success callback input. This is typically
 * a discriminated union of all provider result types (e.g., Oauth2Value | PasskeyProperties).
 * The `provider` field acts as the discriminant.
 */
export interface IssuerCallbacksInterface<Success = unknown> {
  /** Validate live authority on every refresh, including unscoped refreshes. */
  readonly onRefresh?: (input: {
    readonly type: string
    readonly properties: Record<string, unknown>
    readonly clientId: string
    readonly scope: string | undefined
  }) => Effect.Effect<{ readonly properties: Record<string, unknown> }, OnRefreshScopeError>
  /**
   * Called on successful authentication to create tokens.
   * The returned Effect may require KeyManagementService when generating tokens
   * directly (e.g., in client_credentials flow).
   *
   * @param responder - Methods to create the response (e.g., ctx.subject())
   * @param input - Provider result, typed as Success. Use the `provider` field to discriminate.
   * @param req - The HTTP request
   */
  readonly success: (
    responder: OnSuccessResponder,
    input: Success,
    req: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    SuccessCallbackError,
    StorageService | HttpServerRequest.HttpServerRequest | KeyManagementService
  >
  /**
   * Called to validate if a client is allowed to use a redirect URI.
   */
  readonly allow: (
    input: AllowCallbackInput,
    req: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<boolean>
  /**
   * Optional callback at the start of authorization flow.
   */
  readonly start:
    | ((req: HttpServerRequest.HttpServerRequest) => Effect.Effect<void>)
    | undefined
  /**
   * Optional callback to handle scope parameter during refresh token grant.
   * Allows role-switching or scope modification.
   * Errors are converted to invalid_scope responses by the issuer.
   */
  readonly onRefreshScope:
    | ((
        input: OnRefreshScopeInput,
      ) => Effect.Effect<OnRefreshScopeResult, OnRefreshScopeError>)
    | undefined
  /**
   * Resolve a subject identifier from type and properties.
   */
  readonly resolveSubject: (
    type: string,
    properties: unknown,
  ) => Effect.Effect<string>
}

/**
 * Effect service tag for issuer callbacks.
 */
export class IssuerCallbacks extends Context.Tag("@pf/openauth/IssuerCallbacks")<
  IssuerCallbacks,
  IssuerCallbacksInterface
>() {}

/**
 * Create an IssuerCallbacks layer with the given callback implementations.
 *
 * @typeParam Success - The type of the success callback input. This allows you to
 * define a typed discriminated union for your provider results.
 *
 * @example
 * ```ts
 * type MyProviderValue =
 *   | { provider: "google"; tokenset: Oauth2Token; clientID: string }
 *   | { provider: "passkey"; userId: string; email: string }
 *
 * const callbacksLayer = makeIssuerCallbacks<MyProviderValue>({
 *   success: (ctx, input, req) => {
 *     // input is typed as MyProviderValue
 *     if (input.provider === "google") {
 *       // input.tokenset is available here
 *     }
 *   },
 *   // ...
 * })
 * ```
 */
export const makeIssuerCallbacks = <Success = unknown>(
  callbacks: IssuerCallbacksInterface<Success>,
): Layer.Layer<IssuerCallbacks> =>
  Layer.succeed(IssuerCallbacks, callbacks as IssuerCallbacksInterface)

/**
 * Default subject resolver that creates a hash-based identifier.
 */
export const defaultResolveSubject = (
  type: string,
  properties: unknown,
): Effect.Effect<string> => {
  const jsonString = JSON.stringify(properties)
  const data = new TextEncoder().encode(jsonString)
  return Effect.gen(function* () {
    const hashBuffer = yield* Effect.promise(() =>
      crypto.subtle.digest("SHA-1", data),
    )
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
    return `${type}:${hashHex.slice(0, 16)}`
  })
}
