import { Data, Effect } from "effect"

/** Stable boundary messages only; SQL/driver details belong in cause. */
export class DelegationQueryError extends Data.TaggedError(
  "@pf/delegation/DelegationQueryError",
)<{ readonly message: string; readonly cause?: unknown }> {}

export class DelegationWriteError extends Data.TaggedError(
  "@pf/delegation/DelegationWriteError",
)<{ readonly message: string; readonly cause?: unknown }> {}

export const mapDelegationQueryError =
  (message: string) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, DelegationQueryError, R> =>
    effect.pipe(
      Effect.mapError((cause) => new DelegationQueryError({ message, cause })),
    )

export const mapDelegationWriteError =
  (message: string) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, DelegationWriteError, R> =>
    effect.pipe(
      Effect.mapError((cause) => new DelegationWriteError({ message, cause })),
    )
