import { Context, Data, Effect, FiberRef, Layer } from "effect"

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
 * Service providing a FiberRef with the access token for the current request.
 * The token is set at the start of each page render and inherited by all
 * resolver effects running in child fibers.
 */
export class AccessToken extends Context.Tag("@pf/frontend/AccessToken")<
  AccessToken,
  FiberRef.FiberRef<AccessTokenValue>
>() {}

/**
 * Live layer for AccessToken service.
 * Initializes FiberRef with null token - must be set via Effect.locally in page wrapper.
 */
export const AccessTokenLive = Layer.succeed(
  AccessToken,
  FiberRef.unsafeMake<AccessTokenValue>({ token: null }),
)

/**
 * Helper to get the current access token from the AccessToken FiberRef.
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
> => Effect.flatMap(AccessToken, FiberRef.get)
