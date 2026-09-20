/**
 * Refresh token grant handler for token endpoint.
 * @packageDocumentation
 */
import type { HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Clock, Effect, Option } from "effect"
import { errorJson, noStoreJson } from "../../response"
import { IssuerCallbacks } from "../../services/callbacks"
import type { ClientRegistryService } from "../../services/client-registry"
import { TokenTtlConfig } from "../../services/config"
import { CookieAuthService } from "../../services/cookie-auth"
import type {
  KeyManagementService,
  NoSigningKeysError,
} from "../../services/key-management"
import {
  Storage,
  type StorageError,
  type StorageService,
} from "../../storage/storage"
import {
  authenticateClient,
  buildInvalidClientResponse,
} from "../_internal/client-authentication"
import { generateTokens } from "../_internal/token-generation"
import type { MissingHostError, OAuthEndpointError } from "../errors"
import { InvariantViolationError } from "../errors"

/**
 * Handle grant_type=refresh_token
 * Exchanges a refresh token for new tokens.
 */
export const handleRefreshTokenGrant = (
  form: Map<string, string>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  | StorageError
  | MissingHostError
  | OAuthEndpointError
  | NoSigningKeysError
  | InvariantViolationError,
  | TokenTtlConfig
  | CookieAuthService
  | IssuerCallbacks
  | ClientRegistryService
  | KeyManagementService
  | HttpServerRequest.HttpServerRequest
  | StorageService
> =>
  Effect.gen(function* () {
    const ttlConfig = yield* TokenTtlConfig
    const cookieAuth = yield* CookieAuthService
    const callbacks = yield* IssuerCallbacks

    const refreshToken = form.get("refresh_token")
    if (!refreshToken) {
      return yield* errorJson("invalid_request", "Missing refresh_token", 400)
    }

    // Authenticate client
    const authResult = yield* authenticateClient(form).pipe(
      Effect.catchTag("@pf/openauth/ClientAuthError", (error) =>
        Effect.succeed({ error } as const),
      ),
    )

    if ("error" in authResult) {
      return yield* buildInvalidClientResponse(authResult.error.description)
    }

    const { client } = authResult

    const splits = refreshToken.split(":")
    const token = splits.pop()!
    const subject = splits.join(":")
    const key = ["oauth:refresh", subject, token]

    let payload = yield* Storage.get<{
      type: string
      properties: Record<string, unknown>
      clientID: string
      audience?: string
      subject: string
      ttl: {
        access: number
        refresh: number
      }
      nextToken: string
      timeUsed?: number
      expiresAt?: number
    }>(key)

    if (!payload) {
      return yield* errorJson(
        "invalid_grant",
        "Refresh token has been used or expired",
        400,
      )
    }

    if (payload.clientID !== client.id) {
      return yield* errorJson(
        "unauthorized_client",
        "Client is not authorized to use this refresh token",
        403,
      )
    }

    const now = yield* Clock.currentTimeMillis
    if (payload.expiresAt !== undefined && (!Number.isFinite(payload.expiresAt) || now >= payload.expiresAt)) {
      yield* Storage.remove(key)
      return yield* errorJson("invalid_grant", "Credential expired", 400)
    }
    if (callbacks.onRefresh) {
      const checked = yield* callbacks.onRefresh({ type: payload.type, properties: payload.properties,
        clientId: client.id, scope: form.get("scope") }).pipe(Effect.option)
      if (Option.isNone(checked)) return yield* errorJson("invalid_grant", "Session is no longer valid", 400)
      payload = { ...payload, properties: checked.value.properties }
    }

    const ttlRefreshReuse = ttlConfig.refreshReuse
    const ttlRefreshRetention = ttlConfig.refreshRetention
    const generateRefreshToken = !payload.timeUsed

    if (ttlRefreshReuse <= 0) {
      // no reuse interval, remove the refresh token immediately
      yield* Storage.remove(key)
    } else if (!payload.timeUsed) {
      const nowMs = yield* Clock.currentTimeMillis
      const updatedPayload = {
        ...payload,
        timeUsed: nowMs,
      }
      yield* Storage.set(key, updatedPayload, ttlRefreshReuse + ttlRefreshRetention)
    } else {
      const nowMs = yield* Clock.currentTimeMillis
      if (nowMs > payload.timeUsed + ttlRefreshReuse * 1000) {
        // token was reused past the allowed interval
        yield* cookieAuth.invalidate(subject)
        return yield* errorJson(
          "invalid_grant",
          "Refresh token has been used or expired",
          400,
        )
      }
    }

    // Handle scope parameter for role switching
    const scope = form.get("scope")
    let finalPayload = payload
    let accessTtlOverride: number | undefined
    if (scope && callbacks.onRefreshScope) {
      // Extract userId from properties (assumes user subject type)
      const userId = payload.properties["userId"] as string | undefined
      if (!userId) {
        return yield* errorJson(
          "invalid_scope",
          "Cannot determine user for scope validation",
          400,
        )
      }

      const scopeResult = yield* callbacks
        .onRefreshScope({
          userId,
          clientId: client.id,
          scope,
          currentProperties: payload.properties,
        })
        .pipe(
          Effect.map((result) => ({ success: true as const, ...result })),
          Effect.catchAll(() => Effect.succeed({ success: false as const })),
        )

      // Check if the callback failed
      if (!scopeResult.success) {
        return yield* errorJson(
          "invalid_scope",
          "Failed to process scope request",
          400,
        )
      }

      finalPayload = {
        ...payload,
        properties: scopeResult.properties,
      }
      accessTtlOverride = scopeResult.accessTokenTtl
    }

    const tokens = yield* generateTokens(
      {
        type: finalPayload.type,
        properties: finalPayload.properties,
        subject: finalPayload.subject,
        clientID: finalPayload.clientID,
        audience: finalPayload.audience,
        ttl: finalPayload.ttl,
        expiresAt: finalPayload.expiresAt,
        accessTtlOverride,
        timeUsed: payload.timeUsed,
        nextToken: payload.nextToken,
      },
      {
        generateRefreshToken,
        allowExistingRefreshToken: !generateRefreshToken,
      },
    )

    const nextRefreshToken = tokens.refresh
    const refreshExpiresIn = tokens.refreshExpiresIn
    if (!nextRefreshToken || refreshExpiresIn === undefined) {
      return yield* new InvariantViolationError({
        message:
          "Invariant violation: refresh_token flow must issue a refresh token",
      })
    }

    return yield* noStoreJson({
      access_token: tokens.access,
      refresh_token: nextRefreshToken,
      expires_in: tokens.expiresIn,
      refresh_expires_in: refreshExpiresIn,
    })
  }).pipe(
    Effect.catchTag("@pf/openauth/OAuthEndpointError", (error) =>
      errorJson(error.error, error.description, error.statusCode),
    ),
  )
