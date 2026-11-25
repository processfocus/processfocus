import { Redacted } from "effect"

export type Prettify<T> = {
  [K in keyof T]: T[K]
}

/**
 * Collects URL-encoded form parameters into a plain key/value map, unwrapping
 * any `Redacted` values.
 */
export const formValues = (
  params: Iterable<readonly [string, string | Redacted.Redacted<string>]>,
): Map<string, string> => {
  const values = new Map<string, string>()
  for (const [key, value] of params) {
    values.set(key, Redacted.isRedacted(value) ? Redacted.value(value) : value)
  }
  return values
}

export function lazy<T>(fn: () => T): () => T {
  let value: T | undefined
  return () => {
    if (value === undefined) {
      value = fn()
    }
    return value
  }
}
