import { Effect, Schedule } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import { causeChainIncludes, isSqlLockError } from "@pf/db-info"

const retrySchedule = Schedule.max([
  Schedule.exponential("25 millis", 2),
  Schedule.recurs(4),
]).pipe(Schedule.jittered)

/**
 * Own the outer transaction for visibility reads and idempotent observations.
 * Replay only these side-effect-free bodies, re-reading current authorization
 * and rows after rollback. A stale snapshot cannot recover via statement retry.
 */
export const withProcessVisibilityTransaction = <A, E, R>(
  body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SqlError, R | SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.withTransaction(body).pipe(
      Effect.retry({
        schedule: retrySchedule,
        while: (error) =>
          isSqlLockError(error) ||
          causeChainIncludes(error, (message) =>
            message.toLowerCase().includes("database snapshot is stale"),
          ),
      }),
    ),
  )
