import { Schema } from "effect"
import { ConfigurationPreflightFailure } from "./configuration-preflight.js"

const MAX_REASON_LENGTH = 2000
const MAX_STATEMENT_LENGTH = 500
const REDACTED = "[REDACTED]"

const sanitizeOnce = (
  output: string,
  privateValues: readonly string[],
  maxLength: number,
): string => {
  // Locate all redactions in the unchanged input. Substituting a private value
  // first could consume a quote and expose data in a later SQL literal.
  const ranges: Array<{ readonly start: number; readonly end: number }> = []
  const regions: typeof ranges = []
  for (const value of privateValues) {
    if (!value) continue
    for (
      let start = output.indexOf(value);
      start !== -1;
      start = output.indexOf(value, start + 1)
    ) {
      ranges.push({ start, end: start + value.length })
    }
  }
  for (const region of output.matchAll(
    /`(?:``|[^`])*(?:`|$)|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:''|[^'])*(?:'|$)|"(?:""|[^"])*(?:"|$)/g,
  )) {
    const start = region.index
    const end = start + region[0].length
    regions.push({ start, end })
    // Keep schema identifiers unless a known private value overlaps them.
    // SQLite's ambiguous double quotes/brackets are conservatively redacted.
    if (
      !region[0].startsWith("`") ||
      ranges.some((range) => range.start < end && range.end > start)
    ) {
      ranges.push({ start, end })
    }
  }
  // SQLite DEFAULT data need not be quoted. Hide the clause up to the next
  // column/statement boundary, respecting quoted regions and nested expressions.
  for (const keyword of output.matchAll(
    /(?<![\p{ID_Continue}$])DEFAULT(?![\p{ID_Continue}$])/giu,
  )) {
    if (
      regions.some(
        (region) => region.start <= keyword.index && keyword.index < region.end,
      )
    )
      continue
    let start = keyword.index + keyword[0].length
    while (start < output.length && /\s/.test(output[start] ?? "")) start++
    let end = start
    let depth = 0
    while (end < output.length) {
      // A public diagnostic may end in a truncation marker, not SQL data.
      if (
        depth === 0 &&
        end + 3 === output.length &&
        output.startsWith("...", end)
      )
        break
      const region = regions.find((region) => region.start === end)
      if (region) {
        end = region.end
        continue
      }
      const char = output[end]
      if (char === "(") depth++
      else if (char === ")") {
        if (depth === 0) break
        depth--
      } else if (depth === 0 && (char === "," || char === ";")) break
      end++
    }
    if (end > start) ranges.push({ start, end })
  }
  let reason = ""
  let consumed = 0
  for (const range of ranges.sort((a, b) => a.start - b.start)) {
    if (range.end <= consumed) continue
    if (range.start >= consumed) {
      reason += output.slice(consumed, range.start) + REDACTED
    }
    consumed = range.end
  }
  reason += output.slice(consumed)
  reason = reason
    // Control characters are not public diagnostics (the emitter strips ANSI).
    .replace(/[^\S\n]+/g, " ")
    .replace(/[\p{C}\p{Zl}\p{Zp}]/gu, (value) => (value === "\n" ? value : ""))
    // Drop entire URLs, not just recognized query parameter names.
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, REDACTED)
    .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/\bBearer\s+[^\s,;"']+/gi, REDACTED)
    .replace(
      /\b[A-Za-z0-9_-]*(?:token|secret|password|credential|api[_-]?key|access[_-]?key|authorization|signature)[A-Za-z0-9_-]*["']?\s*[:=]\s*(?:"[^"\n]*(?:"|$)|'[^'\n]*(?:'|$)|[^\s,;}\]]+)/gi,
      REDACTED,
    )
    .replace(/\b[A-Za-z0-9_+/=-]{32,}\b/g, REDACTED)
    // Numeric SQL literals can be credentials too. Keep schema identifiers, and
    // redact whole URLs/JWTs above before a numeric segment can split them.
    .replace(
      /`(?:``|[^`])*(?:`|$)|(?<![\p{ID_Continue}$])(?:0x[\da-f](?:_?[\da-f])*|(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:e[+-]?\d(?:_?\d)*)?)(?![\p{ID_Continue}$])/giu,
      (value) => (value.startsWith("`") ? value : REDACTED),
    )
    .trim()
  return reason.length > maxLength
    ? `${reason.slice(0, maxLength - 3)}...`
    : reason
}

/** Redact before truncating, then normalize for stable public revalidation. */
export const sanitizeDeployPhaseFailureReason = (
  output: string,
  privateValues: readonly string[] = [],
  maxLength: number = MAX_REASON_LENGTH,
): string => {
  let reason = sanitizeOnce(output, privateValues, maxLength)
  let next = sanitizeOnce(reason, [], maxLength)
  // Private-value redactions may coalesce with DEFAULT data or a cut marker.
  // Further passes only discard source text or merge already-redacted regions.
  while (next !== reason) {
    reason = next
    next = sanitizeOnce(reason, [], maxLength)
  }
  return reason
}

/** Fixed metadata plus a sanitized, bounded diagnostic; never raw process output. */
export const DeployPhaseFailure = Schema.Struct({
  format: Schema.Literal("processfocus/deploy-phase-failure"),
  version: Schema.Literal(1),
  project: ConfigurationPreflightFailure.fields.project,
  environment: ConfigurationPreflightFailure.fields.environment,
  stage: ConfigurationPreflightFailure.fields.stage,
  phase: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^[a-z][a-z-]{0,63}$/)),
  ),
  reason: Schema.NonEmptyString.pipe(
    Schema.check(Schema.isMaxLength(MAX_REASON_LENGTH)),
  ),
  statement: Schema.optional(
    Schema.NonEmptyString.pipe(
      Schema.check(Schema.isMaxLength(MAX_STATEMENT_LENGTH)),
    ),
  ),
})
export type DeployPhaseFailure = typeof DeployPhaseFailure.Type

/** Discard unsafe payloads and parse errors without rendering private inputs. */
export const decodeDeployPhaseFailure = (
  value: unknown,
): DeployPhaseFailure | undefined => {
  try {
    const failure = Schema.decodeUnknownSync(DeployPhaseFailure)(value)
    return sanitizeDeployPhaseFailureReason(failure.reason) ===
      failure.reason &&
      (failure.statement === undefined ||
        sanitizeDeployPhaseFailureReason(
          failure.statement,
          [],
          MAX_STATEMENT_LENGTH,
        ) === failure.statement)
      ? failure
      : undefined
  } catch {
    return undefined
  }
}

export const formatDeployPhaseFailure = (failure: DeployPhaseFailure): string =>
  `[${failure.phase}] project=${failure.project} environment=${failure.environment} stage=${failure.stage}: ${failure.reason}${failure.statement ? `\nStatement: ${failure.statement}` : ""}`
