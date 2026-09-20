import { Context } from "effect"

/**
 * Service that provides information about the database connection.
 *
 * This service is provided by database driver layers and contains
 * human-readable connection information for logging and debugging.
 *
 * Examples:
 * - ":memory:" for in-memory test databases (SQLite)
 * - "./data/pf.db" for local file databases (sqlite-bun)
 * - "file://./data/pf.db" for local file databases (libsql)
 * - "libsql://my-db.turso.io" for remote databases
 * - "postgresql://user@localhost:5432/dbname" for PostgreSQL
 *
 * @example
 * ```typescript
 * import { DatabaseConnectionInfo } from "@pf/db-info"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function* () {
 *   const connectionInfo = yield* DatabaseConnectionInfo
 *   yield* Effect.log(`Connected to: ${connectionInfo}`)
 * })
 * ```
 */
export class DatabaseConnectionInfo extends Context.Tag(
  "@pf/db-info/DatabaseConnectionInfo",
)<DatabaseConnectionInfo, string>() {}
