const MAX_CAUSES = 12
const MAX_INPUT_LENGTH = 8192

interface DiagnosticCause {
  readonly name: string
  readonly message?: string
  readonly code?: string | number
  readonly stack?: string
}

interface ErrorDiagnostic {
  readonly causes: readonly DiagnosticCause[]
  readonly truncated: "cycle" | "depth" | null
}

// Read only known error fields, including non-enumerable Error properties.
// A broken getter must not replace the resolver's original failure.
const readProperty = (value: unknown, key: string): unknown => {
  if (typeof value !== "object" || value === null) return undefined
  try {
    return Reflect.get(value, key)
  } catch {
    return undefined
  }
}

const safeText = (value: string, limit: number): string => {
  const redacted = value
    .slice(0, MAX_INPUT_LENGTH)
    // Drop entire URLs, including connection userinfo and query strings.
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]*/gi, "[REDACTED_URL]")
    .replace(/\b(?:bearer|basic)\s+[^\s"',;]+/gi, "[REDACTED_AUTH]")
    .replace(
      /((?<![\w-])["']?-*\b(?:[\w-]*(?:password|passwd|pwd|token|secret|credential|api[_-]?key|authorization|signature|connection[_-]?string|dsn)[\w-]*|user(?:name)?)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s,;\]}]+)/gi,
      "$1[REDACTED]",
    )
    // SQL and bind parameters can contain arbitrary private values. Retain
    // the surrounding driver explanation, never the statement/parameter tail.
    .replace(
      /\b(?:(?:select|insert\s+into|update|delete\s+from|replace\s+into|create\s+table|alter\s+table|drop\s+table|pragma)\b|with\s+(?:recursive\s+)?[^\s]+\s+as\s*\()[\s\S]*/gi,
      "[REDACTED_SQL]",
    )
    .replace(/\b(?:params|parameters)\s*[:=][\s\S]*/gi, "[REDACTED_PARAMS]")

  return redacted.length > limit || value.length > MAX_INPUT_LENGTH
    ? `${redacted.slice(0, limit)}[truncated]`
    : redacted
}

/** Server-only, allowlisted diagnostics; never serialize the original object. */
export const errorDiagnostic = (error: unknown): ErrorDiagnostic => {
  const causes: DiagnosticCause[] = []
  const seen = new WeakSet<object>()
  let current = error

  while (current != null) {
    if (typeof current === "object") {
      if (seen.has(current)) return { causes, truncated: "cycle" }
      seen.add(current)
    }
    if (causes.length === MAX_CAUSES) return { causes, truncated: "depth" }

    const tag = readProperty(current, "_tag")
    const rawName = readProperty(current, "name")
    const name =
      typeof tag === "string"
        ? tag
        : typeof rawName === "string"
          ? rawName
          : "UnknownError"
    const rawMessage =
      typeof current === "string" ? current : readProperty(current, "message")
    // Drizzle embeds SQL and binds in its message; retain detail in its cause.
    // Other wrappers still use the generic SQL/credential redaction below.
    const message =
      name === "DrizzleQueryError"
        ? "[REDACTED_SQL]"
        : typeof rawMessage === "string"
          ? safeText(rawMessage, 1024)
          : undefined
    const rawCode = readProperty(current, "code")
    const code =
      typeof rawCode === "string"
        ? safeText(rawCode, 128)
        : typeof rawCode === "number" && Number.isFinite(rawCode)
          ? rawCode
          : undefined
    const rawStack = readProperty(current, "stack")
    // Error.stack repeats the raw (possibly multiline) message. Keep only
    // bounded frames and sanitize each independently, so a match in one frame
    // cannot hide later frames. URL locations remain untrusted and redacted.
    const stack =
      typeof rawStack === "string"
        ? rawStack
            .slice(0, MAX_INPUT_LENGTH)
            .split("\n")
            .filter((line) => /^\s+at\s/.test(line))
            .slice(0, 8)
            .map((line) => safeText(line, 2048))
            .join("\n")
            .slice(0, 2048)
        : undefined

    causes.push({
      name: safeText(name, 128),
      ...(message === undefined ? {} : { message }),
      ...(code === undefined ? {} : { code }),
      ...(stack ? { stack } : {}),
    })
    // Effect SQL exposes reason (also aliased as cause in v4); Drizzle and
    // native Error use cause. Do not traverse query, params or other payloads.
    current = readProperty(current, "cause") ?? readProperty(current, "reason")
  }

  return { causes, truncated: null }
}
