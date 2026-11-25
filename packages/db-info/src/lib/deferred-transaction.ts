import { Context, Effect } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"

export const deferredTransactionRequested = Context.Reference<boolean>(
  "@pf/db-info/deferredTransactionRequested",
  { defaultValue: () => false },
)

/** Defer writer acquisition until a write is needed; this is not read-only. */
export const withDeferredTransaction = <A, E, R>(
  client: SqlClient,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SqlError, R> =>
  client
    .withTransaction(effect)
    .pipe(Effect.provideService(deferredTransactionRequested, true))
