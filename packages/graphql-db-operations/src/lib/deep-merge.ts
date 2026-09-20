/**
 * Deep merge utility for JSON objects.
 *
 * Recursively merges source into target, preserving nested properties.
 * - Objects are merged recursively
 * - Arrays are replaced (not merged)
 * - Primitives are overwritten by source
 * - null values in source delete target keys, matching SQLite json_patch
 * - undefined values in source are ignored
 *
 * @example
 * ```ts
 * deepMerge(
 *   { user: { name: "John", age: 30 }, status: "active" },
 *   { user: { age: 31 } }
 * )
 * // => { user: { name: "John", age: 31 }, status: "active" }
 * ```
 */
export const deepMerge = (
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> => {
  const result = { ...target }

  for (const [key, sourceValue] of Object.entries(source)) {
    // Skip undefined values - they don't overwrite
    if (sourceValue === undefined) {
      continue
    }

    if (sourceValue === null) {
      delete result[key]
      continue
    }

    const targetValue = result[key]

    // Check if both values are plain objects (not arrays, not null)
    if (isPlainObject(sourceValue) && isPlainObject(targetValue)) {
      // Recursively merge objects
      result[key] = deepMerge(
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>,
      )
    } else {
      // Overwrite with source value (primitives, arrays, null)
      result[key] = sourceValue
    }
  }

  return result
}

/**
 * Check if a value is a plain object (not array, not null, not Date, etc.)
 */
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object") {
    return false
  }
  if (Array.isArray(value)) {
    return false
  }
  // Check for plain objects (not class instances like Date, RegExp, etc.)
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
