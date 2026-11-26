import { Context, Effect } from "effect"
import type * as SqlClient from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"

export const immediateTransactionRequested = Context.Reference<boolean>(
  "@pf/db-info/immediateTransactionRequested",
  { defaultValue: () => false },
)

/**
 * Reserve the writer before database-only validation reads on Turso adapters.
 * Snapshot requests take precedence; immediate takes precedence over concurrent.
 * Nested calls use savepoints and never upgrade the outer transaction's mode.
 * Lock acquisition is bounded by the adapter; the body is never replayed here.
 */
export const withImmediateTransaction = <A, E, R>(
  client: SqlClient.SqlClient,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SqlError, R> =>
  client
    .withTransaction(effect)
    .pipe(Effect.provideService(immediateTransactionRequested, true))
