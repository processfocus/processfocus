/**
 * Client authentication helper for OAuth token endpoint.
 * Implements RFC 6749 client authentication methods.
 * @packageDocumentation
 */
import { HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Effect, Either } from "effect"
import { jwtVerify } from "jose"
import { getIssuerUrl } from "../../request"
import { json } from "../../response"
import { ClientRegistryService } from "../../services/client-registry"
import { KeyManagementService } from "../../services/key-management"
import { ClientAuthError } from "../errors"
import type { ClientAuthenticationMethod, NormalizedClient } from "../types"

/**
 * Result of successful client authentication.
 */
export interface ClientAuthResult {
  readonly client: NormalizedClient
  readonly method: ClientAuthenticationMethod
}

interface ClientJwtPayload {
  readonly iss?: string
  readonly properties?: {
    readonly clientId?: unknown
  }
}

const isLoopbackHost = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname === "127.0.0.1" ||
  hostname === "[::1]"

const normalizeIssuerPathname = (pathname: string): string => {
  const normalized = pathname.replace(/\/+$/, "")
  return normalized === "" ? "/" : normalized
}

const isDevelopment = (): boolean => process.env["NODE_ENV"] === "development"

export const issuerMatchesIgnoringLoopbackPort = (
  tokenIssuer: unknown,
  requestIssuer: string,
): boolean => {
  if (!isDevelopment()) {
    return false
  }

  if (typeof tokenIssuer !== "string") {
    return false
  }

  try {
    const tokenUrl = new URL(tokenIssuer)
    const requestUrl = new URL(requestIssuer)
    return (
      tokenUrl.protocol === requestUrl.protocol &&
      isLoopbackHost(tokenUrl.hostname) &&
      isLoopbackHost(requestUrl.hostname) &&
      tokenUrl.hostname === requestUrl.hostname &&
      normalizeIssuerPathname(tokenUrl.pathname) ===
        normalizeIssuerPathname(requestUrl.pathname)
    )
  } catch {
    return false
  }
}

/**
 * Sanitize string for use in WWW-Authenticate header.
 */
function sanitizeAuthenticateDescription(input: string): string {
  return input.replace(/["\r\n]/g, "")
}

/**
 * Decode base64 string safely, returning an Either-like result.
 */
function decodeBase64(
  encoded: string,
): { ok: true; value: string } | { ok: false; error: ClientAuthError } {
  try {
    return { ok: true, value: Buffer.from(encoded, "base64").toString("utf8") }
  } catch {
    return {
      ok: false,
      error: new ClientAuthError({
        description: "Authorization header is not valid base64",
      }),
    }
  }
}

/**
 * Decode URI components safely, returning an Either-like result.
 */
function decodeUriComponents(
  clientPart: string,
  secretPart: string,
): { ok: true; clientId: string; secret: string } | { ok: false; error: ClientAuthError } {
  try {
    return {
      ok: true,
      clientId: decodeURIComponent(clientPart),
      secret: decodeURIComponent(secretPart),
    }
  } catch {
    return {
      ok: false,
      error: new ClientAuthError({
        description: "Authorization header contains invalid percent encoding",
      }),
    }
  }
}

/**
 * Verify a client JWT and extract client ID from claims.
 */
const verifyClientJwt = (
  token: string,
): Effect.Effect<
  string,
  ClientAuthError,
  KeyManagementService | HttpServerRequest.HttpServerRequest
> =>
  Effect.gen(function* () {
    const keyMgmt = yield* KeyManagementService
    const request = yield* HttpServerRequest.HttpServerRequest

    const issuerUrl = yield* getIssuerUrl(request.headers).pipe(
      Effect.mapError(
        () =>
          new ClientAuthError({
            description: "Unable to determine token issuer from request headers",
          }),
      ),
    )

    const signingKeys = yield* keyMgmt.allSigningKeys.pipe(
      Effect.mapError(
        () =>
          new ClientAuthError({
            description: "Failed to load signing keys for client JWT verification",
          }),
      ),
    )

    for (const signingKeyPair of signingKeys) {
      const verifyResult = yield* Effect.tryPromise(() =>
        jwtVerify<ClientJwtPayload>(
          token,
          () => Promise.resolve(signingKeyPair.public),
          {
            issuer: issuerUrl,
          },
        ),
      ).pipe(Effect.either)

      const strictClientId = yield* Either.match(verifyResult, {
        onLeft: () => Effect.succeed(undefined as string | undefined),
        onRight: (verified) => {
          const claimedClientId = verified.payload.properties?.clientId
          if (
            typeof claimedClientId !== "string" ||
            claimedClientId.length === 0
          ) {
            return Effect.fail(
              new ClientAuthError({
                description: "Client JWT is missing properties.clientId claim",
              }),
            )
          }
          return Effect.succeed(claimedClientId)
        },
      })
      if (strictClientId !== undefined) {
        return strictClientId
      }

      // Local dev auth ports can drift. After strict issuer verification fails,
      // re-check the signature and then apply the loopback-only issuer rule.
      const loopbackVerifyResult = yield* Effect.tryPromise(() =>
        jwtVerify<ClientJwtPayload>(token, () =>
          Promise.resolve(signingKeyPair.public),
        ),
      ).pipe(Effect.either)

      const loopbackClientId = yield* Either.match(loopbackVerifyResult, {
        onLeft: () => Effect.succeed(undefined as string | undefined),
        onRight: (verified) => {
          if (
            !issuerMatchesIgnoringLoopbackPort(verified.payload.iss, issuerUrl)
          ) {
            return Effect.succeed(undefined as string | undefined)
          }
          const claimedClientId = verified.payload.properties?.clientId
          if (
            typeof claimedClientId !== "string" ||
            claimedClientId.length === 0
          ) {
            return Effect.fail(
              new ClientAuthError({
                description: "Client JWT is missing properties.clientId claim",
              }),
            )
          }
          return Effect.succeed(claimedClientId)
        },
      })
      if (loopbackClientId !== undefined) {
        return loopbackClientId
      }
    }

    return yield* new ClientAuthError({
      description: "Invalid client JWT",
    })
  })

/**
 * Authenticate a client from a token request.
 * Supports Basic authentication, client_secret_post, and public clients.
 *
 * @returns Effect that succeeds with client and method, or fails with ClientAuthError
 */
export const authenticateClient = (
  form: Map<string, string>,
): Effect.Effect<
  ClientAuthResult,
  ClientAuthError,
  | ClientRegistryService
  | KeyManagementService
  | HttpServerRequest.HttpServerRequest
> =>
  Effect.gen(function* () {
    const clientRegistry = yield* ClientRegistryService
    const request = yield* HttpServerRequest.HttpServerRequest

    const header = request.headers["authorization"]
    let method: ClientAuthenticationMethod = "none"
    let clientId: string | undefined
    let providedSecret: string | undefined

    if (header) {
      const [schemeRaw, credentials] = header.split(" ")
      const scheme = schemeRaw?.toLowerCase()
      if (!scheme || !credentials) {
        return yield* new ClientAuthError({
          description: "Authorization header is malformed",
        })
      }

      if (scheme === "basic") {
        const decodeResult = decodeBase64(credentials)
        if (!decodeResult.ok) {
          return yield* decodeResult.error
        }
        const decoded = decodeResult.value

        const separator = decoded.indexOf(":")
        if (separator === -1) {
          return yield* new ClientAuthError({
            description:
              "Authorization header must contain client_id and client_secret",
          })
        }

        const uriDecodeResult = decodeUriComponents(
          decoded.slice(0, separator),
          decoded.slice(separator + 1),
        )
        if (!uriDecodeResult.ok) {
          return yield* uriDecodeResult.error
        }
        clientId = uriDecodeResult.clientId
        providedSecret = uriDecodeResult.secret

        method = "client_secret_basic"
        if (form.has("client_id") || form.has("oauth_client_id")) {
          return yield* new ClientAuthError({
            description:
              "client_id must not be included in the body when Basic Authorization is used",
          })
        }
      } else if (scheme === "bearer") {
        method = "client_jwt"
        clientId = yield* verifyClientJwt(credentials)

        const bodyClientId = form.get("oauth_client_id") ?? form.get("client_id")
        if (bodyClientId && bodyClientId !== clientId) {
          return yield* new ClientAuthError({
            description:
              "client_id in request body must match properties.clientId in client JWT",
          })
        }
      } else {
        return yield* new ClientAuthError({
          description:
            "Authorization header must use the Basic or Bearer scheme",
        })
      }
    } else {
      const bodyClientId = form.get("oauth_client_id") ?? form.get("client_id")
      if (bodyClientId) {
        clientId = bodyClientId
      }
      const bodySecret = form.get("client_secret")
      if (bodySecret) {
        providedSecret = bodySecret
        method = "client_secret_post"
      }
    }

    if (!clientId) {
      return yield* new ClientAuthError({ description: "Missing client_id" })
    }

    const client = yield* clientRegistry.getClient(clientId)
    if (!client) {
      return yield* new ClientAuthError({ description: "Unknown client" })
    }

    // Verify client credentials
    if (client.secretHash && method !== "client_jwt") {
      if (!providedSecret) {
        return yield* new ClientAuthError({
          description: "Client authentication is required",
        })
      }
      // Argon2id hash verification (constant-time internally)
      const isValid = yield* Effect.tryPromise({
        try: () => Bun.password.verify(providedSecret, client.secretHash!),
        catch: () =>
          new ClientAuthError({
            description: "Failed to verify client credentials",
          }),
      }).pipe(Effect.withSpan("auth.verifyClientSecret"))
      if (!isValid) {
        return yield* new ClientAuthError({
          description: "Invalid client credentials",
        })
      }
    } else if (providedSecret) {
      return yield* new ClientAuthError({
        description: "Public clients must not send client_secret",
      })
    }

    if (client.isPublic && method !== "none") {
      return yield* new ClientAuthError({
        description: "Public clients cannot use Authorization headers",
      })
    }

    const enforcedMethod = client.enforcedAuthMethod
    if (enforcedMethod && method !== enforcedMethod) {
      return yield* new ClientAuthError({
        description: `Client must authenticate using ${enforcedMethod}`,
      })
    }

    if (!client.isPublic && method === "none") {
      return yield* new ClientAuthError({
        description:
          "Confidential clients must authenticate using Basic, client_secret_post, or Bearer client JWT",
      })
    }

    return { client, method }
  }).pipe(Effect.withSpan("auth.authenticateClient"))

/**
 * Build an invalid_client error response with proper headers.
 */
export const buildInvalidClientResponse = (description: string) =>
  json(
    {
      error: "invalid_client",
      error_description: description,
    },
    { status: 401 },
  ).pipe(
    Effect.map((response) =>
      HttpServerResponse.setHeader(
        response,
        "WWW-Authenticate",
        `Basic realm="token", error="invalid_client", error_description="${sanitizeAuthenticateDescription(description)}"`,
      ),
    ),
  )
