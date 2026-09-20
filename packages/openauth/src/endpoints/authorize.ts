/**
 * Authorization endpoint handler.
 * GET /oauth/authorize
 * @packageDocumentation
 */
import { HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Effect } from "effect"
import { serializeCookie } from "../http-middleware/cookies"
import { isValidRedirectUri, normalizeRedirectUri } from "../redirect-uri"
import { getProtocol } from "../request"
import { errorJson } from "../response"
import { IssuerCallbacks } from "../services/callbacks"
import { ClientRegistryService } from "../services/client-registry"
import {
  EncryptionService,
  type NoEncryptionKeysError,
} from "../services/encryption"
import { ProviderRegistryService } from "../services/provider-registry"
import type { StorageError } from "../storage/storage"
import type { AuthorizationState, NormalizedClient } from "./types"

/**
 * Validate redirect URI and return normalized form.
 */
function validateRedirectUri(
  client: NormalizedClient,
  redirectURI: string,
): { ok: true; value: string } | { ok: false } {
  if (!isValidRedirectUri(redirectURI, client.redirectUris)) {
    return { ok: false }
  }
  return { ok: true, value: normalizeRedirectUri(redirectURI) }
}

/**
 * Helper to create error redirect response.
 */
const errorRedirect = (
  redirectUri: string,
  error: string,
  description: string,
  state: string | undefined,
) => {
  const target = new URL(redirectUri)
  target.searchParams.set("error", error)
  target.searchParams.set("error_description", description)
  if (state) {
    target.searchParams.set("state", state)
  }
  return Effect.succeed(
    HttpServerResponse.redirect(target.toString(), { status: 302 }),
  )
}

/**
 * Handle GET /oauth/authorize
 * Validates authorization request, sets authorization cookie, and redirects to provider.
 *
 * This endpoint is fully self-contained - it handles cookie setting and returns
 * the final redirect response.
 *
 * Per OAuth 2.0 spec, errors after redirect_uri validation must redirect back
 * to the client with error params, not return JSON errors.
 */
export const handleAuthorize: Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  StorageError | NoEncryptionKeysError,
  | ClientRegistryService
  | EncryptionService
  | ProviderRegistryService
  | IssuerCallbacks
  | HttpServerRequest.HttpServerRequest
> = Effect.gen(function* () {
  const clientRegistry = yield* ClientRegistryService
  const encryption = yield* EncryptionService
  const providerRegistry = yield* ProviderRegistryService
  const callbacks = yield* IssuerCallbacks
  const request = yield* HttpServerRequest.HttpServerRequest

  // Parse query parameters from the URL
  // request.url may be a path with query string or a full URL
  const urlPath = request.url
  const queryStart = urlPath.indexOf("?")
  const searchParams =
    queryStart >= 0
      ? new URLSearchParams(urlPath.slice(queryStart + 1))
      : new URLSearchParams()

  const provider = searchParams.get("provider") ?? undefined
  const responseType = searchParams.get("response_type") ?? undefined
  const redirectUriParam = searchParams.get("redirect_uri") ?? undefined
  const state = searchParams.get("state") ?? undefined
  const clientIdParam = searchParams.get("client_id") ?? undefined
  const audience = searchParams.get("audience") ?? undefined
  const codeChallenge = searchParams.get("code_challenge") ?? undefined
  const codeChallengeMethod =
    searchParams.get("code_challenge_method") ?? undefined

  // Validate required parameters (return JSON error before redirect_uri validation)
  if (!clientIdParam) {
    return yield* errorJson(
      "invalid_request",
      "Missing parameter: client_id",
      400,
    )
  }

  if (!redirectUriParam) {
    return yield* errorJson(
      "invalid_request",
      "Missing parameter: redirect_uri",
      400,
    )
  }

  if (!responseType) {
    return yield* errorJson(
      "invalid_request",
      "Missing parameter: response_type",
      400,
    )
  }

  const clientId = clientIdParam
  const redirectUri = redirectUriParam

  // Validate client exists (use static registry for authorize endpoint)
  const client = clientRegistry.staticClients.get(clientId)
  if (!client) {
    return yield* errorJson(
      "unauthorized_client",
      `Unknown client: ${clientId}`,
      400,
    )
  }

  // Validate redirect URI
  const redirectResult = validateRedirectUri(client, redirectUri)
  if (!redirectResult.ok) {
    return yield* errorJson(
      "unauthorized_client",
      `Invalid redirect_uri for client: ${clientId}`,
      400,
    )
  }
  const normalizedRedirect = redirectResult.value

  // After redirect_uri validation, errors redirect back to client (OAuth spec)
  if (responseType !== "code") {
    return yield* errorRedirect(
      normalizedRedirect,
      "invalid_request",
      "Only response_type=code is supported",
      state,
    )
  }

  if (codeChallenge && codeChallengeMethod !== "S256") {
    return yield* errorRedirect(
      normalizedRedirect,
      "invalid_request",
      "code_challenge_method must be S256",
      state,
    )
  }

  if (client.isPublic && (!codeChallenge || codeChallengeMethod !== "S256")) {
    return yield* errorRedirect(
      normalizedRedirect,
      "invalid_request",
      "Public clients must use PKCE with code_challenge_method=S256",
      state,
    )
  }

  // Call start callback if configured
  if (callbacks.start) {
    yield* callbacks.start(request)
  }

  // Check allow callback
  const allowed = yield* callbacks.allow(
    {
      clientID: clientId,
      redirectURI: normalizedRedirect,
      audience,
    },
    request,
  )

  if (!allowed) {
    return yield* errorJson(
      "unauthorized_client",
      `Client not allowed: ${clientId}`,
      400,
    )
  }

  // Build authorization state
  const authorization: AuthorizationState = {
    response_type: "code",
    redirect_uri: normalizedRedirect,
    state,
    client_id: clientId,
    audience,
    pkce:
      codeChallenge && codeChallengeMethod
        ? {
            challenge: codeChallenge,
            method: "S256",
          }
        : undefined,
  }

  // Determine redirect URL to provider
  const staticProviderNames = [...providerRegistry.staticProviders.keys()]
  const hasDummyProvider = staticProviderNames.includes("dummy")
  const allProviders = yield* providerRegistry.listProviders

  let redirectUrl: string

  if (provider) {
    if (staticProviderNames.includes(provider)) {
      redirectUrl = `/oauth/${provider}/authorize`
    } else if (allProviders.includes(provider)) {
      // Dynamic provider - catch-all route will handle it
      redirectUrl = `/oauth/${provider}/authorize`
    } else if (hasDummyProvider) {
      yield* Effect.logWarning(
        `Provider '${provider}' not found, falling back to dummy provider`,
      )
      redirectUrl = `/oauth/dummy/authorize`
    } else {
      return yield* errorRedirect(
        normalizedRedirect,
        "invalid_request",
        `Provider '${provider}' is not configured`,
        state,
      )
    }
  } else if (staticProviderNames.length === 1) {
    redirectUrl = `/oauth/${staticProviderNames[0]}/authorize`
  } else {
    return yield* errorRedirect(
      normalizedRedirect,
      "invalid_request",
      "Missing parameter: provider",
      state,
    )
  }

  // Encrypt authorization state and set cookie
  const encryptedAuth = yield* encryption.encrypt(authorization)

  // Determine if the request is secure (HTTPS)
  const isSecure = getProtocol(request.headers) === "https"
  const cookieValue = serializeCookie("authorization", encryptedAuth, {
    maxAge: 60 * 60 * 24,
    httpOnly: true,
    secure: isSecure,
    sameSite: isSecure ? "none" : "lax",
  })

  // Return redirect with cookie
  return HttpServerResponse.redirect(redirectUrl, { status: 302 }).pipe(
    HttpServerResponse.setHeader("Set-Cookie", cookieValue),
  )
})
