import { Duration, Effect, Schedule } from "effect"

const TRANSIENT_TURSO_SERVER_ERROR_MESSAGES = [
  // Keep this intentionally narrow until we observe other retryable Turso
  // transport statuses in CI.
  "HTTP status 502",
] as const
const TRANSIENT_TURSO_HTTP_STATUS = 502
// Observed libsql/Turso wrappers are shallow; eight levels leaves margin while
// preventing unrelated deep causes from triggering an import retry.
const MAX_CAUSE_DEPTH = 8

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const messageMatchesTransientTursoServerError = (message: string): boolean =>
  TRANSIENT_TURSO_SERVER_ERROR_MESSAGES.some((expectedMessage) =>
    message.includes(expectedMessage),
  )

export const isTransientTursoServerError = (error: unknown): boolean => {
  let current: unknown = error
  const seen = new Set<unknown>()
  let depth = 0

  while (current != null && !seen.has(current) && depth < MAX_CAUSE_DEPTH) {
    seen.add(current)
    depth += 1

    if (current instanceof Error) {
      if (messageMatchesTransientTursoServerError(current.message)) {
        return true
      }
      current = current.cause
      continue
    }

    if (isRecord(current)) {
      const message = current["message"]
      if (
        typeof message === "string" &&
        messageMatchesTransientTursoServerError(message)
      ) {
        return true
      }

      const status = current["status"]
      if (
        typeof status === "number" &&
        status === TRANSIENT_TURSO_HTTP_STATUS
      ) {
        return true
      }

      current = current["cause"]
      continue
    }

    if (
      typeof current === "string" &&
      messageMatchesTransientTursoServerError(current)
    ) {
      return true
    }

    if (
      typeof current === "number" &&
      current === TRANSIENT_TURSO_HTTP_STATUS
    ) {
      return true
    }

    break
  }

  return false
}

const TRANSIENT_TURSO_SERVER_ERROR_RETRY_SCHEDULE = Schedule.addDelay(
  Schedule.recurs(1),
  () => Duration.millis(250),
)

export const retryTransientTursoServerError = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      schedule: TRANSIENT_TURSO_SERVER_ERROR_RETRY_SCHEDULE,
      while: isTransientTursoServerError,
    }),
  )
