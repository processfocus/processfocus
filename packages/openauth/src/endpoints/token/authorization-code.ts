/**
 * Authorization code grant handler for token endpoint.
 * @packageDocumentation
 */
import type { HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Effect } from "effect"
import { validatePKCE } from "../../pkce"
import { tryNormalizeRedirectUri } from "../../redirect-uri"
import { errorJson, noStoreJson } from "../../response"
import type { ClientRegistryService } from "../../services/client-registry"
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
import type { AuthorizationState } from "../types"

/**
 * Handle grant_type=authorization_code
 * Exchanges an authorization code for tokens.
 */
export const handleAuthorizationCodeGrant = (
  form: Map<string, string>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  | StorageError
  | MissingHostError
  | OAuthEndpointError
  | NoSigningKeysError
  | InvariantViolationError,
  | ClientRegistryService
  | KeyManagementService
  | HttpServerRequest.HttpServerRequest
  | StorageService
> =>
  Effect.gen(function* () {
    const code = form.get("code")
    if (!code) {
      return yield* errorJson("invalid_request", "Missing code", 400)
    }

    const redirectParam = form.get("redirect_uri")
    if (!redirectParam) {
      return yield* errorJson("invalid_request", "Missing redirect_uri", 400)
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

    const normalizeResult = tryNormalizeRedirectUri(redirectParam)
    if (!normalizeResult.ok) {
      return yield* errorJson(
        "invalid_redirect_uri",
        "Redirect URI mismatch",
        400,
      )
    }
    const normalizedRedirect = normalizeResult.value

    const key = ["oauth:code", code]
    const payload = yield* Storage.get<{
      type: string
      properties: unknown
      clientID: string
      redirectURI: string
      subject: string
      audience?: string
      ttl: {
        access: number
        refresh: number
      }
      pkce?: AuthorizationState["pkce"]
    }>(key)

    if (!payload) {
      return yield* errorJson(
        "invalid_grant",
        "Authorization code has been used or expired",
        400,
      )
    }

    if (payload.redirectURI !== normalizedRedirect) {
      return yield* errorJson(
        "invalid_redirect_uri",
        "Redirect URI mismatch",
        400,
      )
    }

    const requestClientId = form.get("client_id")
    if (requestClientId && requestClientId !== client.id) {
      return yield* errorJson(
        "unauthorized_client",
        "Client is not authorized to use this authorization code",
        403,
      )
    }

    if (payload.clientID !== client.id) {
      return yield* errorJson(
        "unauthorized_client",
        "Client is not authorized to use this authorization code",
        403,
      )
    }

    if (client.isPublic && !payload.pkce) {
      return yield* errorJson(
        "invalid_grant",
        "PKCE is required for this client",
        400,
      )
    }

    if (payload.pkce) {
      const codeVerifier = form.get("code_verifier")
      if (!codeVerifier) {
        return yield* errorJson("invalid_grant", "Missing code_verifier", 400)
      }

      const pkceValid = yield* Effect.promise(() =>
        validatePKCE(codeVerifier, payload.pkce!.challenge, payload.pkce!.method),
      ).pipe(Effect.withSpan("auth.validatePKCE"))
      if (!pkceValid) {
        return yield* errorJson(
          "invalid_grant",
          "Code verifier does not match",
          400,
        )
      }
    }

    const tokens = yield* generateTokens({
      type: payload.type,
      properties: payload.properties,
      subject: payload.subject,
      clientID: payload.clientID,
      audience: payload.audience,
      ttl: payload.ttl,
      timeUsed: undefined,
      nextToken: undefined,
    })

    yield* Storage.remove(key)

    const refreshToken = tokens.refresh
    const refreshExpiresIn = tokens.refreshExpiresIn
    if (!refreshToken || refreshExpiresIn === undefined) {
      return yield* new InvariantViolationError({
        message:
          "Invariant violation: authorization_code flow must issue a refresh token",
      })
    }

    return yield* noStoreJson({
      access_token: tokens.access,
      expires_in: tokens.expiresIn,
      refresh_token: refreshToken,
      refresh_expires_in: refreshExpiresIn,
    })
  })
