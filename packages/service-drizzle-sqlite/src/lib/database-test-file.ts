import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Config, ConfigProvider, Effect, Layer } from "effect"
import { SqliteLive } from "@pf/layer-sqlite-bun"
import { runSqliteTestMigrations } from "./test-migrations"
import { TypedSqliteDrizzleLayer } from "./typed-drizzle"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const defaultMigrationsFolder = join(
  __dirname,
  "../../../drizzle-sqlite/drizzle",
)

/**
 * Config for the migrations folder path.
 * Can be overridden using ConfigProvider.fromMap({ MIGRATIONS_FOLDER: "/custom/path" })
 */
export const MigrationsFolderConfig = Config.string("MIGRATIONS_FOLDER").pipe(
  Config.withDefault(defaultMigrationsFolder),
)

/**
 * Generates a random temporary database filename.
 * Uses $TMPDIR if set, otherwise falls back to /tmp.
 *
 * @returns Absolute path to a temporary database file (e.g., /tmp/test-pf-abc123.db)
 */
export const generateTempDbPath = (): string => {
  const tmpDir = process.env["TMPDIR"] || "/tmp"
  const randomSuffix = Math.random().toString(36).substring(2, 15)
  const timestamp = Date.now()
  return join(tmpDir, `test-pf-${timestamp}-${randomSuffix}.db`)
}

/**
 * Creates a file-based test database layer with migrations.
 *
 * This layer creates a SQLite database at the specified file path and runs all migrations.
 * Unlike DatabaseTest (which uses :memory:), this layer creates a persistent database file
 * that can be shared across multiple Effect scopes.
 *
 * The database path is injected via ConfigProvider to avoid global state mutations.
 *
 * Use case: Testing GraphQL servers or other scenarios where multiple components need
 * to access the same database instance.
 *
 * @param dbPath - Absolute path to the database file (e.g., /tmp/test-pf.db)
 * @returns Layer that provides TypedSqliteDrizzle with a migrated database
 *
 * @example
 * ```typescript
 * import { DatabaseTestFile, generateTempDbPath } from "@pf/service-drizzle-sqlite/test-file"
 * import { Effect } from "effect"
 * import { unlink } from "node:fs/promises"
 *
 * const testProgram = Effect.gen(function* () {
 *   const dbPath = generateTempDbPath()
 *   const db = yield* TypedSqliteDrizzle
 *   // Use database...
 *   yield* Effect.promise(() => unlink(dbPath)) // Cleanup
 * }).pipe(
 *   Effect.provide(DatabaseTestFile(dbPath))
 * )
 * ```
 */
export const DatabaseTestFile = (dbPath: string) => {
  // Create config provider with the database path
  const ConfigProviderLayer = Layer.setConfigProvider(
    ConfigProvider.fromMap(new Map([["SQLITE_DATABASE_PATH", dbPath]])),
  )

  // Create the drizzle layer with SqliteLive, exporting both TypedSqliteDrizzle and SqlClient
  const DrizzleTestFile = Layer.provideMerge(
    TypedSqliteDrizzleLayer,
    SqliteLive,
  ).pipe(Layer.provide(ConfigProviderLayer))

  return Layer.effectDiscard(
    Effect.gen(function* () {
      const migrationsFolder = yield* MigrationsFolderConfig
      yield* runSqliteTestMigrations(migrationsFolder)
    }),
  ).pipe(Layer.provideMerge(DrizzleTestFile))
}

export * from "./typed-drizzle"
