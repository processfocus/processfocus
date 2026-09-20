import { Duration, Effect, Schedule } from "effect"
import { causeChainIncludes, isSqlLockError } from "@pf/db-info"

// Observed when Turso closes a remote socket mid-query:
// "The socket connection was closed unexpectedly" or a nested cause code.
const TRANSIENT_SOCKET_ERROR_MESSAGES = [
  "socket connection was closed unexpectedly",
] as const
const TRANSIENT_SQLITE_ERROR_CODES = ["ECONNRESET"] as const

const valueIncludesAny = (
  value: string,
  expectedValues: readonly string[],
): boolean =>
  expectedValues.some((expectedValue) => value.includes(expectedValue))

const valueEqualsAny = (
  value: string,
  expectedValues: readonly string[],
): boolean => expectedValues.some((expectedValue) => value === expectedValue)

export const isSqliteBusy = (error: unknown): boolean => isSqlLockError(error)

export const isTransientSqliteError = (error: unknown): boolean =>
  isSqlLockError(error) ||
  causeChainIncludes(
    error,
    (message) => valueIncludesAny(message, TRANSIENT_SOCKET_ERROR_MESSAGES),
    {
      codePredicate: (code) =>
        valueEqualsAny(code, TRANSIENT_SQLITE_ERROR_CODES),
    },
  )

const TRANSIENT_SQLITE_RETRY_SCHEDULE = Schedule.addDelay(
  Schedule.recurs(3),
  () => Duration.millis(100),
)

export const retryTransientSqliteError = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      schedule: TRANSIENT_SQLITE_RETRY_SCHEDULE,
      while: isTransientSqliteError,
    }),
  )
