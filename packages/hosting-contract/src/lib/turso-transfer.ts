export const TURSO_LOGICAL_DUMP_PATH = "/dump"
export const TURSO_LOGICAL_DUMP_PREFIX_INSPECT_BYTES = 4096
export const TURSO_LOGICAL_DUMP_SUFFIX_INSPECT_BYTES = 256

const plausibleSqlDumpPrefix =
  /^\s*(?:--[^\n]*\n\s*)*(?:PRAGMA|BEGIN|CREATE|INSERT|DELETE|UPDATE|COMMIT|REPLACE|DROP|ALTER)\b/iu
const plausibleSqlDumpSuffix = /\bCOMMIT\s*;\s*$/iu

export class TursoDatabaseUrlError extends Error {
  override readonly name = "TursoDatabaseUrlError"

  constructor() {
    super(
      "Turso database URL must be a bare libsql: host URL with no credentials, non-root path, query, or fragment",
    )
  }
}

const parseTursoLibsqlUrl = (sourceUrl: string): URL => {
  try {
    const url = new URL(sourceUrl)
    if (
      url.protocol === "libsql:" &&
      url.hostname.length > 0 &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      (url.pathname === "" || url.pathname === "/") &&
      url.search === "" &&
      url.hash === ""
    ) {
      return url
    }
  } catch {
    // Fall through to one sanitized error because the input may contain a
    // credential-bearing URL.
  }

  throw new TursoDatabaseUrlError()
}

/** Canonicalize a Console/Turso libsql URL without retaining a root slash. */
export const canonicalTursoLibsqlUrl = (sourceUrl: string): string => {
  const url = parseTursoLibsqlUrl(sourceUrl)
  return `libsql://${url.host.toLowerCase()}`
}

/** Convert a canonical Turso libsql URL to the equivalent HTTPS origin. */
export const httpsUrlFromTursoLibsqlUrl = (sourceUrl: string): string => {
  const url = parseTursoLibsqlUrl(sourceUrl)
  return `https://${url.host.toLowerCase()}`
}

/** Convert a canonical Turso libsql URL to its authenticated dump endpoint. */
export const httpsDumpUrlFromTursoLibsqlUrl = (sourceUrl: string): string =>
  `${httpsUrlFromTursoLibsqlUrl(sourceUrl)}${TURSO_LOGICAL_DUMP_PATH}`

export const isPlausibleTursoSqlDumpPrefix = (
  firstBytes: Uint8Array,
): boolean => {
  if (firstBytes.byteLength === 0) {
    return false
  }
  const length = Math.min(
    firstBytes.byteLength,
    TURSO_LOGICAL_DUMP_PREFIX_INSPECT_BYTES,
  )
  return plausibleSqlDumpPrefix.test(
    new TextDecoder().decode(firstBytes.subarray(0, length)),
  )
}

export const isPlausibleTursoSqlDumpSuffix = (
  lastBytes: Uint8Array,
): boolean => {
  if (lastBytes.byteLength === 0) {
    return false
  }
  const start = Math.max(
    0,
    lastBytes.byteLength - TURSO_LOGICAL_DUMP_SUFFIX_INSPECT_BYTES,
  )
  return plausibleSqlDumpSuffix.test(
    new TextDecoder().decode(lastBytes.subarray(start)),
  )
}

const TURSO_INTERNAL_OBJECT_TARGET = `["']?__turso_internal_[A-Za-z0-9_]+`

const TURSO_INTERNAL_STATEMENT_PATTERNS: ReadonlyArray<RegExp> = [
  new RegExp(
    String.raw`^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?` +
      TURSO_INTERNAL_OBJECT_TARGET,
    "iu",
  ),
  new RegExp(
    String.raw`^INSERT\s+INTO\s+` + TURSO_INTERNAL_OBJECT_TARGET,
    "iu",
  ),
  new RegExp(
    String.raw`^DELETE\s+FROM\s+` + TURSO_INTERNAL_OBJECT_TARGET,
    "iu",
  ),
  new RegExp(String.raw`^UPDATE\s+` + TURSO_INTERNAL_OBJECT_TARGET, "iu"),
  new RegExp(
    String.raw`^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?` +
      TURSO_INTERNAL_OBJECT_TARGET,
    "iu",
  ),
]

const isTursoInternalSchemaOrMutationStatement = (
  statementStart: string,
): boolean =>
  TURSO_INTERNAL_STATEMENT_PATTERNS.some((pattern) =>
    pattern.test(statementStart.trimStart()),
  )

type SqlLexicalState =
  | "backtickIdentifier"
  | "blockComment"
  | "bracketIdentifier"
  | "doubleQuotedIdentifier"
  | "normal"
  | "singleQuotedString"

interface SqlLineScan {
  readonly state: SqlLexicalState
  readonly statementTerminated: boolean
}

const scanSqlLine = (
  line: string,
  initialState: SqlLexicalState,
): SqlLineScan => {
  let state = initialState

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    const next = line[index + 1]

    switch (state) {
      case "normal":
        if (character === "-" && next === "-") {
          return { state, statementTerminated: false }
        }
        if (character === "/" && next === "*") {
          state = "blockComment"
          index += 1
        } else if (character === "'") {
          state = "singleQuotedString"
        } else if (character === '"') {
          state = "doubleQuotedIdentifier"
        } else if (character === "`") {
          state = "backtickIdentifier"
        } else if (character === "[") {
          state = "bracketIdentifier"
        } else if (character === ";") {
          return { state: "normal", statementTerminated: true }
        }
        break
      case "singleQuotedString":
        if (character === "'" && next === "'") {
          index += 1
        } else if (character === "'") {
          state = "normal"
        }
        break
      case "doubleQuotedIdentifier":
        if (character === '"' && next === '"') {
          index += 1
        } else if (character === '"') {
          state = "normal"
        }
        break
      case "backtickIdentifier":
        if (character === "`" && next === "`") {
          index += 1
        } else if (character === "`") {
          state = "normal"
        }
        break
      case "bracketIdentifier":
        if (character === "]") {
          state = "normal"
        }
        break
      case "blockComment":
        if (character === "*" && next === "/") {
          state = "normal"
          index += 1
        }
        break
    }
  }

  return { state, statementTerminated: false }
}

/**
 * Remove Turso-owned table schema and mutations while preserving user SQL,
 * `sqlite_sequence`, and values that merely mention an internal object name.
 */
export const filterTursoInternalStatements = (sql: string): string => {
  const lines = sql.split(/\r?\n/u)
  const filtered: Array<string> = []
  let skippingStatement = false
  let lexicalState: SqlLexicalState = "normal"

  for (const line of lines) {
    if (skippingStatement) {
      const scan = scanSqlLine(line, lexicalState)
      lexicalState = scan.state
      if (scan.statementTerminated) {
        skippingStatement = false
        lexicalState = "normal"
      }
      continue
    }

    if (
      lexicalState === "normal" &&
      isTursoInternalSchemaOrMutationStatement(line)
    ) {
      const scan = scanSqlLine(line, lexicalState)
      lexicalState = scan.state
      if (!scan.statementTerminated) {
        skippingStatement = true
      } else {
        lexicalState = "normal"
      }
      continue
    }

    filtered.push(line)
    lexicalState = scanSqlLine(line, lexicalState).state
  }

  return filtered.join("\n")
}
