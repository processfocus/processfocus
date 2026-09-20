/**
 * Token generation helper for OAuth token endpoint.
 * Handles JWT access token creation and refresh token storage.
 * @packageDocumentation
 */
import { HttpServerRequest } from "@effect/platform"
import { Clock, Effect } from "effect"
import { SignJWT } from "jose"
import { getIssuerUrl } from "../../request"
import {
  KeyManagementService,
  type NoSigningKeysError,
} from "../../services/key-management"
import {
  Storage,
  type StorageError,
  type StorageService,
} from "../../storage/storage"
import type { MissingHostError } from "../errors"
import { InvariantViolationError, OAuthEndpointError } from "../errors"

/**
 * Input for generating OAuth tokens.
 */
export interface GenerateTokensInput {
  readonly type: string
  readonly properties: unknown
  readonly subject: string
  readonly clientID: string
  /** Audience claim for the access token. Defaults to clientID if not specified. */
  readonly audience: string | undefined
  readonly ttl: {
    readonly access: number
    readonly refresh: number
  }
  /** Optional access token TTL override (e.g. for CLI tokens). Does not persist to refresh payload. */
  readonly accessTtlOverride?: number | undefined
  /** Absolute credential deadline in Unix milliseconds; retained across rotation. */
  readonly expiresAt?: number | undefined
  readonly timeUsed: number | undefined
  readonly nextToken: string | undefined
}

/**
 * Options for token generation.
 */
export interface GenerateTokensOptions {
  /** Whether to generate and store a new refresh token. Defaults to true. */
  readonly generateRefreshToken?: boolean
  /**
   * Allow returning an existing reserved refresh token without writing a new
   * storage entry. This is only valid for refresh-token reuse-window replays.
   */
  readonly allowExistingRefreshToken?: boolean
}

/**
 * Result of token generation.
 */
export interface GeneratedTokens {
  readonly access: string
  readonly expiresIn: number
  readonly refresh?: string
  readonly refreshExpiresIn?: number
}

/**
 * Generate an OAuth access token and, when requested, a refresh token.
 *
 * @param value - Token payload including subject, properties, and TTL
 * @param opts - Optional configuration for token generation
 * @returns Effect that succeeds with generated tokens
 */
export const generateTokens = (
  value: GenerateTokensInput,
  opts?: GenerateTokensOptions,
): Effect.Effect<
  GeneratedTokens,
  | StorageError
  | MissingHostError
  | OAuthEndpointError
  | NoSigningKeysError
  | InvariantViolationError,
  KeyManagementService | HttpServerRequest.HttpServerRequest | StorageService
> =>
  Effect.gen(function* () {
    const keyMgmt = yield* KeyManagementService
    const request = yield* HttpServerRequest.HttpServerRequest
    const nowMs = yield* Clock.currentTimeMillis
    if (value.expiresAt !== undefined && (!Number.isFinite(value.expiresAt) || value.expiresAt <= nowMs)) {
      return yield* new OAuthEndpointError({
        error: "invalid_grant",
        description: "Credential expired",
        statusCode: 400,
      })
    }
    const refreshTtl = Math.min(value.ttl.refresh, value.expiresAt === undefined ? Infinity : (value.expiresAt - nowMs) / 1000)
    const effectiveAccessTtl = value.accessTtlOverride ?? value.ttl.access
    const accessTimeUsed = Math.floor((value.timeUsed ?? nowMs) / 1000)
    const accessExpiry = Math.floor(Math.min(accessTimeUsed + effectiveAccessTtl, value.expiresAt === undefined ? Infinity : value.expiresAt / 1000))
    const expiresIn = Math.floor(accessExpiry - nowMs / 1000)
    // Never store a successor or report success for a zero-lifetime credential.
    if (expiresIn <= 0) {
      return yield* new OAuthEndpointError({
        error: "invalid_grant",
        description: "Credential expired",
        statusCode: 400,
      })
    }

    const shouldGenerateRefreshToken = opts?.generateRefreshToken ?? true
    if (
      value.nextToken !== undefined &&
      !shouldGenerateRefreshToken &&
      !opts?.allowExistingRefreshToken
    ) {
      return yield* new InvariantViolationError({
        message:
          "Invariant violation: nextToken requires storage write or explicit reuse opt-in",
      })
    }

    const refreshToken = value.nextToken ??
      (shouldGenerateRefreshToken ? crypto.randomUUID() : undefined)

    if (shouldGenerateRefreshToken && refreshToken) {
      /**
       * Generate and store the next refresh token after the one we are currently returning.
       * Reserving these in advance avoids concurrency issues with multiple refreshes.
       * Similar treatment should be given to any other values that may have race conditions,
       * for example if a jti claim was added to the access token.
       */
      const refreshValue = {
        type: value.type,
        properties: value.properties,
        subject: value.subject,
        clientID: value.clientID,
        audience: value.audience,
        ttl: value.ttl,
        expiresAt: value.expiresAt,
        nextToken: crypto.randomUUID(),
      }
      yield* Storage.set(
        ["oauth:refresh", value.subject, refreshToken],
        refreshValue,
        refreshTtl,
      )
    }
    const signingKeyPair = yield* keyMgmt.signingKey.pipe(
      Effect.withSpan("auth.getSigningKey"),
    )

    const issuerUrl = yield* getIssuerUrl(request.headers)

    const access = yield* Effect.promise(() =>
      new SignJWT({
        mode: "access",
        type: value.type,
        properties: value.properties,
        aud: value.audience ?? value.clientID,
        iss: issuerUrl,
        sub: value.subject,
      })
        .setExpirationTime(accessExpiry)
        .setProtectedHeader({
          alg: signingKeyPair.alg,
          kid: signingKeyPair.id,
          typ: "JWT",
        })
        .sign(signingKeyPair.private),
    ).pipe(Effect.withSpan("auth.signAccessToken"))

    // Note: expiresIn reflects remaining lifetime, not the full TTL.
    // When a refresh token is reused within the reuse window, accessTimeUsed
    // is the timestamp of the *first* use, so the JWT and expiresIn are
    // anchored to that earlier moment. This is intentional (the JWT exp and
    // expiresIn stay consistent), but callers like the CLI may receive a
    // shorter expiresIn than the configured accessTokenTtl.
    const generatedTokens: GeneratedTokens = {
      access,
      expiresIn,
    }

    if (!refreshToken) {
      return generatedTokens
    }

    return {
      ...generatedTokens,
      refresh: [value.subject, refreshToken].join(":"),
      refreshExpiresIn: Math.floor(refreshTtl),
    }
  }).pipe(Effect.withSpan("auth.generateTokens"))
