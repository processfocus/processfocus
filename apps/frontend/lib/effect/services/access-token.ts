import { Context, Data, type Effect, Layer } from "effect"

/**
 * Authentication error thrown when no access token is available.
 * Pages must handle this to ensure proper authentication.
 */
export class GraphQLAuthenticationError extends Data.TaggedError(
  "GraphQLAuthenticationError",
)<{
  readonly message: string
}> {}

interface AccessTokenValue {
  readonly token: string | null
}

/**
 * Access token for the current request.
 * The token is set at the start of each page render and inherited by all
 * resolver effects running in child fibers.
 */
export class AccessToken extends Context.Service<
  AccessToken,
  AccessTokenValue
>()("@pf/frontend/AccessToken") {}

/**
 * Live layer for AccessToken service.
 * The page wrapper supplies the authenticated token with Effect.provideService.
 */
export const AccessTokenLive = Layer.succeed(AccessToken, { token: null })

/**
 * Helper to get the current access token from the AccessToken request-local service.
 *
 * @example
 * ```typescript
 * const { token } = yield* getAccessToken()
 * ```
 */
export const getAccessToken = (): Effect.Effect<
  AccessTokenValue,
  never,
  AccessToken
> => AccessToken
