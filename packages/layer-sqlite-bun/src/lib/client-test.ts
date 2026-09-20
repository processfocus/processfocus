import { SqlClient, type SqlError } from "@effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Context, Effect, Layer } from "effect"
import type { ConfigError } from "effect/ConfigError"
import { DatabaseConnectionInfo } from "@pf/db-info"

/**
 * Runs essential SQLite pragmas for test databases.
 *
 * Only `PRAGMA foreign_keys = ON` is needed for in-memory databases.
 * busy_timeout is not relevant for :memory: databases since they're single-connection.
 * WAL mode is enabled by default by Bun's sqlite driver.
 *
 * Note: Pragmas run at layer construction because Bun's sqlite driver opens
 * connections eagerly - there's no benefit to deferring.
 */
const runPragmas = (ctx: Context.Context<SqlClient.SqlClient>) =>
  Effect.gen(function* () {
    const sql = Context.get(ctx, SqlClient.SqlClient)
    yield* sql`PRAGMA foreign_keys = ON`
  })

/**
 * Base SQLite client layer using an in-memory database.
 */
const BaseSqliteTest = SqliteClient.layer({
  filename: ":memory:",
}).pipe(Layer.tap(runPragmas))

/**
 * Layer that provides database connection info for test databases.
 * Returns ":memory:" since test databases are in-memory.
 */
const ConnectionInfoLayer = Layer.succeed(DatabaseConnectionInfo, ":memory:")

/**
 * Creates a test SQLite client layer using an in-memory database.
 *
 * This is the test implementation that uses an in-memory database (":memory:")
 * which is reset on every test run.
 *
 * ## Pragma Execution
 *
 * `PRAGMA foreign_keys = ON` is executed at layer construction to ensure
 * foreign key constraints are enforced in tests. This is critical for
 * catching data integrity issues during testing.
 *
 * Also provides DatabaseConnectionInfo service with ":memory:" for logging.
 *
 * @example
 * ```typescript
 * import { SqliteTest } from "@pf/layer-sqlite-bun"
 * import { Effect } from "effect"
 *
 * // Use in your tests
 * const testProgram = Effect.gen(function* () {
 *   const sql = yield* SqliteClient.SqliteClient
 *   // Use sql...
 * }).pipe(Effect.provide(SqliteTest))
 * ```
 */
export const SqliteTest: Layer.Layer<
  SqlClient.SqlClient | SqliteClient.SqliteClient | DatabaseConnectionInfo,
  ConfigError | SqlError.SqlError,
  never
> = BaseSqliteTest.pipe(Layer.provideMerge(ConnectionInfoLayer))
