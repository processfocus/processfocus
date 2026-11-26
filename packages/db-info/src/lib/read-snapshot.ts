import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import type * as SqlClient from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"

export const readSnapshotRequested = Context.Reference<boolean>(
  "@pf/db-info/readSnapshotRequested",
  { defaultValue: () => false },
)

/**
 * Group database-only reads into one snapshot. Turso Cloud uses BEGIN DEFERRED
 * to avoid reserving a writer; local SQLite/Turso clients already use BEGIN.
 * Inside an existing transaction, reuse its snapshot and begin mode.
 * Callers must keep writes and external effects outside this boundary.
 */
export const withReadSnapshot = <A, E, R>(
  client: SqlClient.SqlClient,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SqlError, R> =>
  client
    .withTransaction(effect)
    .pipe(Effect.provideService(readSnapshotRequested, true))
