const DEFAULT_MAX_CAUSE_DEPTH = 16

const SQL_LOCK_MESSAGE_FRAGMENTS = [
  "sqlite_busy",
  "sqlite_locked",
  "database is locked",
] as const

const SQL_LOCK_CODES = ["SQLITE_BUSY", "SQLITE_LOCKED"] as const
const SQL_WRITE_WRITE_CONFLICT =
  /write[- ]write\s+conflict|concurrent\s+write\s+conflict/iu

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

export type CauseChainIncludesOptions = {
  readonly maxDepth?: number
  readonly codePredicate?: (code: string) => boolean
}

/**
 * Walk an error cause chain looking for a matching message (and optional code).
 * Stops on cycles, non-chainable values, or the depth limit.
 */
export const causeChainIncludes = (
  cause: unknown,
  messagePredicate: (message: string) => boolean,
  options?: CauseChainIncludesOptions,
): boolean => {
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_CAUSE_DEPTH
  const codePredicate = options?.codePredicate
  let current: unknown = cause
  const seen = new WeakSet<object>()
  let depth = 0

  while (current != null && depth < maxDepth) {
    depth += 1

    if (current instanceof Error) {
      if (seen.has(current)) {
        return false
      }
      seen.add(current)

      if (messagePredicate(current.message)) {
        return true
      }

      const code = (current as { readonly code?: unknown }).code
      if (typeof code === "string" && codePredicate?.(code) === true) {
        return true
      }

      current = current.cause
      continue
    }

    if (isRecord(current)) {
      if (seen.has(current)) {
        return false
      }
      seen.add(current)

      const message = current["message"]
      if (typeof message === "string" && messagePredicate(message)) {
        return true
      }

      const code = current["code"]
      if (typeof code === "string" && codePredicate?.(code) === true) {
        return true
      }

      current = current["cause"]
      continue
    }

    if (typeof current === "string" && messagePredicate(current)) {
      return true
    }

    break
  }

  return false
}

const isSqlLockMessage = (message: string): boolean =>
  SQL_WRITE_WRITE_CONFLICT.test(message) ||
  SQL_LOCK_MESSAGE_FRAGMENTS.some((fragment) =>
    message.toLowerCase().includes(fragment),
  )

const isSqlLockCode = (code: string): boolean => {
  const normalizedCode = code.toUpperCase()
  return SQL_LOCK_CODES.some(
    (lockCode) =>
      normalizedCode === lockCode || normalizedCode.includes(lockCode),
  )
}

/**
 * True when the error or any nested cause indicates a SQLite/Turso lock
 * (busy, locked, concurrent write conflict).
 */
export const isSqlLockError = (error: unknown): boolean =>
  causeChainIncludes(error, isSqlLockMessage, {
    codePredicate: isSqlLockCode,
  })

/** True when the error indicates a concurrent commit write-write conflict. */
export const isSqlWriteWriteConflictError = (error: unknown): boolean =>
  causeChainIncludes(error, (message) => SQL_WRITE_WRITE_CONFLICT.test(message))
