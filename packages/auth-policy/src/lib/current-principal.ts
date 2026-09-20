import { Context, Effect, FiberRef } from "effect"
import type { ProviderUserPrincipal } from "./types"

/**
 * FiberRef service holding the current request's provider user principal.
 *
 * Set to `null` for unauthenticated requests or service accounts.
 * Updated per-request in `wrapResolver` via `Effect.locally`.
 *
 * Usage:
 * ```typescript
 * const principal = yield* getCurrentPrincipal()
 * if (principal) {
 *   // provider user principal available
 * }
 * ```
 */
export class CurrentPrincipal extends Context.Tag(
  "@pf/auth-policy/CurrentPrincipal",
)<CurrentPrincipal, FiberRef.FiberRef<ProviderUserPrincipal | null>>() {}

/**
 * Helper to get the current principal from the FiberRef.
 * Returns `null` for unauthenticated requests or service accounts.
 */
export const getCurrentPrincipal = (): Effect.Effect<
  ProviderUserPrincipal | null,
  never,
  CurrentPrincipal
> =>
  Effect.gen(function* () {
    const principalRef = yield* CurrentPrincipal
    return yield* FiberRef.get(principalRef)
  })
