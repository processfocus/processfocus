import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Config, Context, Effect, Layer, Schema } from "effect"
import type { ConfigError } from "effect/Config"
import { SqlClient, type SqlError } from "effect/sql"
import { DatabaseConnectionInfo, DatabasePathConfig } from "@pf/db-info"

export interface SqliteLiveOptions {
  readonly busy_timeout?: number
  readonly disableWAL?: boolean
  readonly initializePragmas?: boolean
}

const DEFAULT_BUSY_TIMEOUT_MS = 500

/**
 * Configuration for database path with validation.
 * Uses DatabasePathConfig from @pf/db-info (SQLITE_DATABASE_PATH > PF_ORG).
 * Ensures the path is not empty.
 */
const ValidatedDatabasePathConfig = DatabasePathConfig.pipe(
  Config.mapEffect((path) =>
    Schema.decodeUnknownEffect(
      Schema.String.check(
        Schema.makeFilter((value) => value.trim().length > 0, {
          message:
            "Database path cannot be empty. Set SQLITE_DATABASE_PATH or PF_ORG environment variable.",
        }),
      ),
    )(path).pipe(Effect.mapError((cause) => new Config.ConfigError(cause))),
  ),
)

/**
 * Runs essential SQLite pragmas using the provided client context.
 *
 * These pragmas give Bun SQLite the behavior required by local GraphQL/worker
 * clients:
 * - `PRAGMA journal_mode = WAL` - Allows readers during writes
 * - `PRAGMA foreign_keys = ON` - Enforces foreign key constraints (critical for data integrity)
 * - `PRAGMA busy_timeout = 500` - Wait up to 500ms when database is locked
 *
 * We run pragmas at layer construction because Bun's sqlite driver opens the
 * connection eagerly when the layer is built.
 */
const runPragmas =
  (options: SqliteLiveOptions | undefined) =>
  (ctx: Context.Context<SqlClient.SqlClient>) =>
    Effect.gen(function* () {
      const sql = Context.get(ctx, SqlClient.SqlClient)
      // Preserve v3's deferred BEGIN. v4 defaults to IMMEDIATE, which reserves
      // the writer even for the existing read-only publication snapshots.
      const withTransaction = SqlClient.makeWithTransaction({
        transactionService: sql.transactionService,
        spanAttributes: [["db.system.name", "sqlite"]],
        acquireConnection: (restore) => restore(sql.reserve),
        begin: (connection) =>
          connection.executeUnprepared("BEGIN DEFERRED", [], undefined),
        commit: (connection) =>
          connection.executeUnprepared("COMMIT", [], undefined),
        rollback: (connection) =>
          connection.executeUnprepared("ROLLBACK", [], undefined),
        savepoint: (connection, id) =>
          connection.executeUnprepared(
            `SAVEPOINT effect_sql_${id}`,
            [],
            undefined,
          ),
        releaseSavepoint: (connection, id) =>
          connection.executeUnprepared(
            `RELEASE SAVEPOINT effect_sql_${id}`,
            [],
            undefined,
          ),
        rollbackSavepoint: (connection, id) =>
          connection.executeUnprepared(
            `ROLLBACK TO SAVEPOINT effect_sql_${id}`,
            [],
            undefined,
          ),
      })
      Object.assign(sql, { withTransaction })
      const busyTimeout = options?.busy_timeout ?? DEFAULT_BUSY_TIMEOUT_MS
      yield* sql`PRAGMA journal_mode = WAL`
      yield* sql`PRAGMA foreign_keys = ON`
      if (busyTimeout > 0) {
        const query = `PRAGMA busy_timeout = ${busyTimeout}`
        yield* sql(Object.assign([query], { raw: [query] }))
      }
    })

/**
 * Base SQLite client layer using a persistent database file.
 * Uses SQLITE_DATABASE_PATH or derives path from PF_ORG/db/pf.db.
 */
const makeBaseSqliteLive = (options?: SqliteLiveOptions) => {
  const layer = SqliteClient.layerConfig({
    filename: ValidatedDatabasePathConfig,
    disableWAL: Config.succeed(options?.disableWAL ?? false),
  })

  return options?.initializePragmas === false
    ? layer
    : layer.pipe(Layer.tap(runPragmas(options)))
}

/**
 * Layer that provides database connection info for live databases.
 * Returns the configured database path from SQLITE_DATABASE_PATH or PF_ORG.
 */
const ConnectionInfoLayer = Layer.effect(
  DatabaseConnectionInfo,
  ValidatedDatabasePathConfig,
)

/**
 * Creates a live SQLite client layer using Bun's sqlite driver.
 *
 * This is the production implementation that uses a real database file.
 * The database path is resolved from SQLITE_DATABASE_PATH (preferred) or
 * derived from PF_ORG as $PF_ORG/db/pf.db (fallback).
 * The application will fail with ConfigError if neither is provided.
 *
 * ## Pragma Execution
 *
 * SQLite pragmas are executed at layer construction time:
 * - `PRAGMA journal_mode = WAL` - Allows readers during writes
 * - `PRAGMA foreign_keys = ON` - Enforces foreign key constraints
 * - `PRAGMA busy_timeout = 500` - Wait up to 500ms when database is locked
 *
 * Pragmas run at layer construction because Bun's sqlite driver opens the
 * connection eagerly.
 *
 * Also provides DatabaseConnectionInfo service with the database path for logging.
 *
 * @example
 * ```typescript
 * import { SqliteLive } from "@pf/layer-sqlite-bun"
 * import { Effect } from "effect"
 *
 * // Option 1: explicit path (takes priority)
 * process.env.SQLITE_DATABASE_PATH = "/path/to/database.db"
 *
 * // Option 2: derive from PF_ORG (fallback)
 * process.env.PF_ORG = "examples/demo" // → examples/demo/db/pf.db
 *
 * // Use in your program
 * const program = Effect.gen(function* () {
 *   const sql = yield* SqliteClient.SqliteClient
 *   // Use sql...
 * }).pipe(Effect.provide(SqliteLive))
 * ```
 */
export const makeSqliteLive = (
  options?: SqliteLiveOptions,
): Layer.Layer<
  SqlClient.SqlClient | SqliteClient.SqliteClient | DatabaseConnectionInfo,
  ConfigError | SqlError.SqlError,
  never
> => makeBaseSqliteLive(options).pipe(Layer.provideMerge(ConnectionInfoLayer))

export const SqliteLive: Layer.Layer<
  SqlClient.SqlClient | SqliteClient.SqliteClient | DatabaseConnectionInfo,
  ConfigError | SqlError.SqlError,
  never
> = makeSqliteLive()
