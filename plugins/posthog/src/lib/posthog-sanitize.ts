const PUBLIC_FORM_PATH_PATTERN = /\/public\/form\/[^\s/?#]+/
const MAX_SANITIZE_DEPTH = 20
const CIRCULAR_REFERENCE = "[Circular]"

interface PostHogEventLike {
  readonly properties?: Record<string, unknown>
  readonly $set?: Record<string, unknown>
  readonly $set_once?: Record<string, unknown>
}

export const sanitizePublicFormUrl = (value: string): string =>
  value.replace(
    new RegExp(PUBLIC_FORM_PATH_PATTERN.source, "g"),
    "/public/form/[token]",
  )

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const sanitizePublicFormTokenValues = (
  value: unknown,
  activeObjects = new WeakSet<object>(),
  depth = 0,
): unknown => {
  if (typeof value === "string") {
    return sanitizePublicFormUrl(value)
  }

  // Strings are handled first; past this limit, nested objects are preserved.
  if (depth >= MAX_SANITIZE_DEPTH) {
    return value
  }

  if (Array.isArray(value)) {
    if (activeObjects.has(value)) {
      return CIRCULAR_REFERENCE
    }

    activeObjects.add(value)
    const sanitized = value.map((nestedValue) =>
      sanitizePublicFormTokenValues(nestedValue, activeObjects, depth + 1),
    )
    activeObjects.delete(value)

    return sanitized
  }

  if (isPlainRecord(value)) {
    if (activeObjects.has(value)) {
      return CIRCULAR_REFERENCE
    }

    activeObjects.add(value)
    const sanitized = Object.fromEntries(
      Object.entries(value).map(
        ([key, nestedValue]) =>
          [
            key,
            sanitizePublicFormTokenValues(
              nestedValue,
              activeObjects,
              depth + 1,
            ),
          ] as const,
      ),
    )
    activeObjects.delete(value)

    return sanitized
  }

  // Preserve URL, Error, Date, and other richer event payload objects.
  return value
}

const sanitizeRecord = (
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined =>
  value
    ? (sanitizePublicFormTokenValues(value) as Record<string, unknown>)
    : undefined

export const sanitizePostHogPublicFormEvent = <T extends PostHogEventLike>(
  event: T | null,
): T | null => {
  if (!event) {
    return null
  }

  return {
    ...event,
    ...(event.properties
      ? { properties: sanitizeRecord(event.properties) }
      : {}),
    ...(event.$set ? { $set: sanitizeRecord(event.$set) } : {}),
    ...(event.$set_once ? { $set_once: sanitizeRecord(event.$set_once) } : {}),
  }
}

export const isPublicFormPathname = (pathname: string): boolean =>
  pathname.startsWith("/public/form/")
