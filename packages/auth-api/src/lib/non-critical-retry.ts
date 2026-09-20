import { Effect, Schedule } from "effect"

/**
 * Check if an error is a SQLite busy/locked error by walking the cause chain.
 * The actual SQLITE_BUSY error is nested inside SqlError wrappers from
 * @effect/sql-sqlite-bun and @effect/sql-drizzle, so we need to check
 * the full chain rather than just the top-level message.
 */
const isSqliteBusyError = (error: unknown): boolean => {
  let current: unknown = error
  while (current != null) {
    if (current instanceof Error) {
      if (
        current.message.includes("SQLITE_BUSY") ||
        current.message.includes("database is locked")
      ) {
        return true
      }
      current = current.cause
    } else if (
      typeof current === "object" &&
      "message" in current &&
      typeof current.message === "string"
    ) {
      if (
        current.message.includes("SQLITE_BUSY") ||
        current.message.includes("database is locked")
      ) {
        return true
      }
      current = "cause" in current ? current.cause : undefined
    } else if (
      typeof current === "string" &&
      (current.includes("SQLITE_BUSY") ||
        current.includes("database is locked"))
    ) {
      return true
    } else {
      break
    }
  }
  return false
}

/**
 * Retry schedule for non-critical database updates.
 * 2 attempts with 100ms delay between each.
 */
const nonCriticalRetrySchedule = Schedule.addDelay(
  Schedule.recurs(1),
  () => 100,
)

/**
 * Wraps a non-critical database update (like updateLastLoggedIn) with retry logic.
 * If the update fails due to SQLite contention after retries, logs a warning and continues.
 * This prevents transient database lock errors from failing the entire authentication flow.
 */
export const withNonCriticalRetry = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  description: string,
): Effect.Effect<void, never, R> =>
  effect.pipe(
    Effect.retry({
      schedule: nonCriticalRetrySchedule,
      while: isSqliteBusyError,
    }),
    Effect.asVoid,
    Effect.catchAll((error) =>
      Effect.logWarning(
        `Non-critical update failed: ${description}, continuing anyway`,
      ).pipe(Effect.annotateLogs({ error })),
    ),
  )

/**
 * Retry policy for upsertM2MUser in auth-server client_credentials flow.
 * 4 retries with exponential backoff: 100ms, 200ms, 400ms, 800ms.
 */
const M2M_UPSERT_MAX_RETRIES = 4

export const withM2MUpsertRetry = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.retry({
      while: isSqliteBusyError,
      schedule: Schedule.exponential("100 millis", 2).pipe(
        Schedule.intersect(Schedule.recurs(M2M_UPSERT_MAX_RETRIES)),
      ),
    }),
  )
