import { Context, Data, Effect, Layer } from "effect"
import {
  DEFAULT_AUTH_PORT,
  getFrontendJwtIssuer,
  getIssuerUrl,
} from "@pf/auth-session"

export type IssuerUrls = [string, ...string[]]

const DEFAULT_LOCAL_ISSUER_URL = `http://localhost:${DEFAULT_AUTH_PORT}`

class NoOAuthIssuerError extends Data.TaggedError(
  "@pf/NoOAuthIssuerError",
  // biome-ignore lint/complexity/noBannedTypes: Effect TaggedError pattern
)<{}> {}

/**
 * The expected JWT audience for the GraphQL server.
 * All clients (frontend, M2M/CI) must request tokens with this audience.
 */
export const GRAPHQL_AUDIENCE = "graphql-api"

/**
 * Configuration for JWT authentication
 */
export interface AuthConfigData {
  /**
   * The issuer URL for JWT tokens (e.g., http://localhost:4020).
   * Used for `iss` claim verification.
   */
  readonly issuerUrl: string

  /**
   * Issuers accepted during JWT verification.
   *
   * Local auth ports can drift when another runtime already owns the default
   * port. In that case a long-lived frontend JWT may still carry the old
   * loopback issuer while the active auth server and JWKS are on a new port.
   * The JWKS URI still points at `issuerUrl`; stale-port tokens are accepted
   * locally because the auth server reuses the same signing key across restarts.
   */
  readonly issuerUrls: IssuerUrls

  /**
   * JWKS endpoint for fetching signing keys.
   * Defaults to `{issuerUrl}/.well-known/jwks.json` when not set.
   *
   * On first deploy (no CDN yet) this points directly at the auth
   * Lambda function URL so the GraphQL server can verify tokens
   * without CloudFront being available.
   */
  readonly jwksUri: string
}

const isLoopbackIssuer = (issuer: string): boolean => {
  try {
    const url = new URL(issuer)
    return (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]"
    )
  } catch {
    return false
  }
}

const loopbackIssuersShareUrlExceptPort = (
  tokenIssuer: string,
  expectedIssuer: string,
): boolean => {
  try {
    const tokenUrl = new URL(tokenIssuer)
    const expectedUrl = new URL(expectedIssuer)
    return (
      isLoopbackIssuer(tokenIssuer) &&
      isLoopbackIssuer(expectedIssuer) &&
      tokenUrl.protocol === expectedUrl.protocol &&
      tokenUrl.hostname === expectedUrl.hostname &&
      tokenUrl.pathname === expectedUrl.pathname &&
      tokenUrl.search === expectedUrl.search &&
      tokenUrl.hash === expectedUrl.hash
    )
  } catch {
    return false
  }
}

const isDevelopment = (): boolean => process.env["NODE_ENV"] === "development"

const getAllowedIssuerUrls = (issuerUrl: string): IssuerUrls => {
  if (!isDevelopment() || !isLoopbackIssuer(issuerUrl)) {
    return [issuerUrl]
  }

  const frontendJwtIssuer = getFrontendJwtIssuer()
  if (
    frontendJwtIssuer &&
    frontendJwtIssuer !== issuerUrl &&
    loopbackIssuersShareUrlExceptPort(frontendJwtIssuer, issuerUrl)
  ) {
    return [issuerUrl, frontendJwtIssuer]
  }

  // The GraphQL env often lacks the browser's frontend JWT, but the browser may
  // still hold a token from the default local auth port after a local restart.
  if (
    !frontendJwtIssuer &&
    DEFAULT_LOCAL_ISSUER_URL !== issuerUrl &&
    loopbackIssuersShareUrlExceptPort(DEFAULT_LOCAL_ISSUER_URL, issuerUrl)
  ) {
    return [issuerUrl, DEFAULT_LOCAL_ISSUER_URL]
  }

  return [issuerUrl]
}

export class AuthConfig extends Context.Tag("@pf/graphql-api/AuthConfig")<
  AuthConfig,
  AuthConfigData
>() {}

/**
 * Effect that reads authentication configuration from environment variables.
 * Exported to allow runtime-specific layers to reuse this logic without duplication.
 *
 * @returns Effect containing issuerUrl and audience read from environment
 * - If OAUTH_ISSUER_URL is set, uses it
 * - In development, tries to read port from .auth-port file
 * - Falls back to http://localhost:4020 when not in production
 * - Else yield the NoOAuthIssuerError
 */
export const readAuthConfigFromEnv = Effect.try({
  try: () => {
    const issuerUrl = getIssuerUrl()
    return {
      issuerUrl,
      issuerUrls: getAllowedIssuerUrls(issuerUrl),
      jwksUri: process.env["JWKS_URI"] ?? `${issuerUrl}/.well-known/jwks.json`,
    }
  },
  catch: () => new NoOAuthIssuerError(),
})

/**
 * Live implementation of AuthConfig that reads from environment variables
 * with sensible defaults for local development.
 */
export const AuthConfigLive = Layer.effect(
  AuthConfig,
  Effect.gen(function* () {
    const config = yield* readAuthConfigFromEnv
    return AuthConfig.of(config)
  }),
)
