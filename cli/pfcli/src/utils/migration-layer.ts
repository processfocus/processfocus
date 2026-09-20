import * as Client from "@effect/sql/SqlClient"
import { readMigrationFiles } from "drizzle-orm/migrator"
import { getMigrationsToRun } from "drizzle-orm/migrator.utils"
import { Effect, Either, Layer } from "effect"
import { makeDatabaseConfigLayer } from "@pf/db-info"
import { MigrationError } from "../errors"
import { makePfcliSqlClientLayer } from "./local-database-layer"

const isSafeMigrationTableName = (name: string): boolean =>
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)

const quoteSqlString = (value: string): string =>
  `'${value.replaceAll("'", "''")}'`

const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`

const formatErrorWithCauses = (error: unknown): string => {
  const parts: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error

  while (current && !seen.has(current)) {
    seen.add(current)

    if (current instanceof Error) {
      parts.push(current.message)
      current = current.cause
      continue
    }

    if (typeof current === "object") {
      const obj = current as Record<string, unknown>
      if (typeof obj["message"] === "string") {
        parts.push(obj["message"])
      }
      current = obj["cause"]
      continue
    }

    if (typeof current === "string") {
      parts.push(current)
    }
    break
  }

  const uniqueParts = parts.filter(
    (part, index) => part && parts.indexOf(part) === index,
  )

  return uniqueParts.join(" -> ") || "Unknown migration error"
}

const stripSqlCommentsAndLiterals = (statement: string): string => {
  let stripped = ""
  let quote: "'" | '"' | "`" | undefined
  let inLineComment = false
  let inBlockComment = false

  for (let index = 0; index < statement.length; index += 1) {
    const char = statement[index]
    const next = statement[index + 1]

    if (char === undefined) break

    if (inLineComment) {
      if (char === "\n") {
        stripped += char
        inLineComment = false
      }
      continue
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        index += 1
        inBlockComment = false
      }
      continue
    }

    if (quote) {
      stripped += " "
      if (char === quote) {
        if (next === quote) {
          stripped += " "
          index += 1
        } else {
          quote = undefined
        }
      }
      continue
    }

    if (char === "-" && next === "-") {
      index += 1
      inLineComment = true
      continue
    }

    if (char === "/" && next === "*") {
      index += 1
      inBlockComment = true
      continue
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char
    }

    stripped += char
  }

  return stripped
}

const isUnterminatedTriggerStatement = (statement: string): boolean => {
  const sql = stripSqlCommentsAndLiterals(statement).trim()
  const count = (pattern: RegExp): number => sql.match(pattern)?.length ?? 0

  if (!/^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(sql)) {
    return false
  }

  return count(/\bBEGIN\b/gi) + count(/\bCASE\b/gi) > count(/\bEND\b/gi)
}

const splitSqlScript = (script: string): readonly string[] => {
  const statements: string[] = []
  let current = ""
  let quote: "'" | '"' | "`" | undefined
  let inLineComment = false
  let inBlockComment = false

  for (let index = 0; index < script.length; index += 1) {
    const char = script[index]
    const next = script[index + 1]

    if (char === undefined) break

    if (inLineComment) {
      current += char
      if (char === "\n") {
        inLineComment = false
      }
      continue
    }

    if (inBlockComment) {
      current += char
      if (char === "*" && next === "/") {
        current += next
        index += 1
        inBlockComment = false
      }
      continue
    }

    if (quote) {
      current += char
      if (char === quote) {
        if (next === quote) {
          current += next
          index += 1
        } else {
          quote = undefined
        }
      }
      continue
    }

    if (char === "-" && next === "-") {
      current += char
      current += next
      index += 1
      inLineComment = true
      continue
    }

    if (char === "/" && next === "*") {
      current += char
      current += next
      index += 1
      inBlockComment = true
      continue
    }

    if (char === "'" || char === '"' || char === "`") {
      current += char
      quote = char
      continue
    }

    if (char === ";") {
      const statement = current.trim()
      if (isUnterminatedTriggerStatement(statement)) {
        current += char
        continue
      }

      if (statement.length > 0) {
        statements.push(statement)
      }
      current = ""
      continue
    }

    current += char
  }

  const statement = current.trim()
  if (statement.length > 0) {
    statements.push(statement)
  }

  return statements
}

const hasSqlContent = (statement: string): boolean => {
  let inLineComment = false
  let inBlockComment = false

  for (let index = 0; index < statement.length; index += 1) {
    const char = statement[index]
    const next = statement[index + 1]

    if (char === undefined) break

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false
      }
      continue
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        index += 1
        inBlockComment = false
      }
      continue
    }

    if (char === "-" && next === "-") {
      index += 1
      inLineComment = true
      continue
    }

    if (char === "/" && next === "*") {
      index += 1
      inBlockComment = true
      continue
    }

    if (!/\s/.test(char)) {
      return true
    }
  }

  return false
}

export const executeMigrationStatements = (
  queries: readonly string[],
): Effect.Effect<void, MigrationError, Client.SqlClient> =>
  Effect.gen(function* () {
    const sqlClient = yield* Client.SqlClient

    for (const query of queries) {
      const statements = splitSqlScript(query)

      for (const statement of statements) {
        if (!hasSqlContent(statement)) continue

        const template = Object.assign([statement], { raw: [statement] })
        const result = yield* Effect.either(sqlClient(template))

        if (Either.isLeft(result)) {
          return yield* new MigrationError({
            reason: formatErrorWithCauses(result.left),
            statement: statement.substring(0, 200),
            cause: result.left,
          })
        }
      }
    }
  })

/**
 * Build a SqlClient layer suitable for running migrations.
 * Shared by `migrate.ts` (system) and `migrate-custom.ts` (org).
 */
export const makeMigrationLayer = (databasePath: string) =>
  makePfcliSqlClientLayer(databasePath).pipe(
    Layer.provide(makeDatabaseConfigLayer(databasePath)),
  )

type LocalMigration = ReturnType<typeof readMigrationFiles>[number]

type DbMigrationRow = {
  readonly id: number | null
  readonly hash: string
  readonly created_at: string | number | null
  readonly name: string | null
}

/**
 * Ensure the migrations journal table exists with drizzle-kit's current
 * columns (hash/created_at/name/applied_at).
 *
 * Intentionally uses `PRAGMA table_info(...)` (statement form). Drizzle's
 * `migrate()` upgrade path queries `pragma_table_info(?)` (table-valued
 * function); on Turso multiprocess_wal that TVF poisons the connection so
 * later writes appear to succeed in-process but never hit the WAL and are
 * lost when the connection closes.
 */
const ensureMigrationsTable = (migrationsTable: string) =>
  Effect.gen(function* () {
    if (!isSafeMigrationTableName(migrationsTable)) {
      return yield* new MigrationError({
        reason: `Invalid migrations table name: ${migrationsTable}`,
        cause: undefined,
      })
    }

    const sql = yield* Client.SqlClient
    const table = quoteIdent(migrationsTable)

    yield* executeMigrationStatements([
      `CREATE TABLE IF NOT EXISTS ${table} (
			id INTEGER PRIMARY KEY,
			hash text NOT NULL,
			created_at numeric,
			name text,
			applied_at TEXT
		)`,
    ])

    const columns = yield* sql.unsafe(`PRAGMA table_info(${migrationsTable})`)
    const columnNames = new Set(
      columns.map((row) => String((row as { name?: unknown }).name ?? "")),
    )

    if (!columnNames.has("name")) {
      yield* executeMigrationStatements([
        `ALTER TABLE ${table} ADD COLUMN name text`,
      ])
    }
    if (!columnNames.has("applied_at")) {
      yield* executeMigrationStatements([
        `ALTER TABLE ${table} ADD COLUMN applied_at TEXT`,
      ])
    }
  })

/**
 * Backfill `name` on journal rows that predate drizzle-kit's name column,
 * matching drizzle-orm's upgradeAsyncIfNeeded heuristics (millis, then hash).
 */
const backfillMigrationNames = (
  migrationsTable: string,
  localMigrations: readonly LocalMigration[],
  dbMigrations: readonly DbMigrationRow[],
) =>
  Effect.gen(function* () {
    const needsBackfill = dbMigrations.some((row) => row.name == null)
    if (!needsBackfill) return

    const byMillis = new Map<number, LocalMigration[]>()
    const byHash = new Map<string, LocalMigration>()
    for (const local of localMigrations) {
      const millisBucket = byMillis.get(local.folderMillis) ?? []
      millisBucket.push(local)
      byMillis.set(local.folderMillis, millisBucket)
      byHash.set(local.hash, local)
    }

    const unmatched: DbMigrationRow[] = []
    const updates: { id: number | null; hash: string; name: string }[] = []

    for (const dbRow of dbMigrations) {
      if (dbRow.name != null) continue

      const stringified = String(dbRow.created_at ?? "")
      const millis = Number(
        stringified.length >= 3
          ? `${stringified.slice(0, stringified.length - 3)}000`
          : stringified,
      )
      const candidates = Number.isFinite(millis)
        ? byMillis.get(millis)
        : undefined

      let matched: LocalMigration | undefined
      if (candidates?.length === 1) {
        matched = candidates[0]
      } else if (candidates && candidates.length > 1) {
        matched = candidates.find((candidate) => candidate.hash === dbRow.hash)
      } else {
        matched = byHash.get(dbRow.hash)
      }

      if (!matched?.name) {
        unmatched.push(dbRow)
        continue
      }

      updates.push({ id: dbRow.id, hash: dbRow.hash, name: matched.name })
    }

    if (unmatched.length > 0) {
      return yield* new MigrationError({
        reason: `While upgrading migrations table ${migrationsTable} found ${unmatched.length} database migration(s) that do not match any local migration (${unmatched
          .map(
            (row) =>
              `[id: ${String(row.id)}, created_at: ${String(row.created_at)}]`,
          )
          .join(", ")})`,
        cause: undefined,
      })
    }

    const table = quoteIdent(migrationsTable)
    for (const update of updates) {
      if (update.id != null) {
        yield* executeMigrationStatements([
          `UPDATE ${table} SET name = ${quoteSqlString(update.name)} WHERE id = ${update.id}`,
        ])
      } else {
        yield* executeMigrationStatements([
          `UPDATE ${table} SET name = ${quoteSqlString(update.name)} WHERE hash = ${quoteSqlString(update.hash)}`,
        ])
      }
    }
  })

/**
 * Run folder-based drizzle-kit migrations against the given journal table.
 *
 * Must be executed inside a scope that provides `SqlClient`
 * (i.e. wrapped with `Effect.provide(migrationLayer)`).
 *
 * Does not call drizzle-orm's `migrate()`: that path runs
 * `SELECT ... FROM pragma_table_info(?)`, which breaks write durability on
 * Turso local multiprocess_wal (writes look applied in-process, then vanish
 * when the connection closes).
 */
export const runDrizzleMigrations = (opts: {
  migrationsFolder: string
  migrationsTable: string
}) =>
  Effect.gen(function* () {
    const sql = yield* Client.SqlClient
    const localMigrations = yield* Effect.try({
      try: () => readMigrationFiles(opts),
      catch: (error) =>
        new MigrationError({
          reason: formatErrorWithCauses(error),
          cause: error,
        }),
    })

    yield* ensureMigrationsTable(opts.migrationsTable)

    const table = quoteIdent(opts.migrationsTable)
    const rawRows = yield* sql.unsafe(
      `SELECT id, hash, created_at, name FROM ${table}`,
    )
    const dbMigrations: DbMigrationRow[] = rawRows.map((row) => {
      const record = row as Record<string, unknown>
      return {
        id:
          typeof record["id"] === "number"
            ? record["id"]
            : record["id"] == null
              ? null
              : Number(record["id"]),
        hash: String(record["hash"] ?? ""),
        created_at:
          typeof record["created_at"] === "string" ||
          typeof record["created_at"] === "number"
            ? record["created_at"]
            : record["created_at"] == null
              ? null
              : String(record["created_at"]),
        name:
          typeof record["name"] === "string"
            ? record["name"]
            : record["name"] == null
              ? null
              : String(record["name"]),
      }
    })

    yield* backfillMigrationNames(
      opts.migrationsTable,
      localMigrations,
      dbMigrations,
    )

    const refreshedRows = yield* sql.unsafe(
      `SELECT id, hash, created_at, name FROM ${table}`,
    )
    const refreshedDbMigrations = refreshedRows.map((row, index) => {
      const record = row as Record<string, unknown>
      const id =
        typeof record["id"] === "number"
          ? record["id"]
          : record["id"] == null
            ? index + 1
            : Number(record["id"])
      return {
        id: Number.isFinite(id) ? id : index + 1,
        hash: String(record["hash"] ?? ""),
        created_at: String(record["created_at"] ?? ""),
        name:
          typeof record["name"] === "string"
            ? record["name"]
            : record["name"] == null
              ? null
              : String(record["name"]),
      }
    })

    const migrationsToRun = getMigrationsToRun({
      localMigrations,
      dbMigrations: refreshedDbMigrations,
    })

    if (migrationsToRun.length === 0) {
      return
    }

    const appliedAt = new Date().toISOString()
    const queries: string[] = ["PRAGMA foreign_keys=ON"]
    for (const migration of migrationsToRun) {
      queries.push(...migration.sql)
      queries.push(
        `INSERT INTO ${table} ("hash", "created_at", "name", "applied_at") VALUES (${quoteSqlString(migration.hash)}, ${migration.folderMillis}, ${quoteSqlString(migration.name)}, ${quoteSqlString(appliedAt)})`,
      )
    }

    yield* executeMigrationStatements(queries)
  })
