/**
 * Extract a meaningful error message from an SQL-ish error, including the
 * cause chain. Accepts any object with `message` and optional `cause` so
 * callers can pass `@effect/sql` `SqlError` without this package depending
 * on that package.
 */
export const formatSqlError = (error: {
  readonly message: string
  readonly cause?: unknown
}): string => {
  const parts: string[] = [error.message]

  // Walk the cause chain to get underlying error details
  let current: unknown = error.cause
  while (current) {
    if (current instanceof Error) {
      parts.push(current.message)
      current = current.cause
    } else if (typeof current === "object" && current !== null) {
      const obj = current as Record<string, unknown>
      if ("message" in obj && typeof obj["message"] === "string") {
        parts.push(obj["message"])
      }
      current = "cause" in obj ? obj["cause"] : undefined
    } else if (typeof current === "string") {
      parts.push(current)
      break
    } else {
      break
    }
  }

  return parts.join(" -> ")
}
