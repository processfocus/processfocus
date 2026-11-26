import { PgClient } from "@effect/sql-pg"
import { Config, Effect, Layer } from "effect"
import { DatabaseConnectionInfo } from "@pf/db-info"

/**
 * Layer that provides database connection info for PostgreSQL databases.
 * Returns a connection string like "postgresql://user@host:5432/dbname"
 */
const ConnectionInfoLayer = Layer.effect(
  DatabaseConnectionInfo,
  Effect.gen(function* () {
    const username = yield* Config.String("POSTGRES_USERNAME").pipe(
      Config.withDefault("postgres"),
    )
    const database = yield* Config.String("POSTGRES_DATABASE").pipe(
      Config.withDefault("postgres"),
    )
    const host = yield* Config.String("POSTGRES_HOST").pipe(
      Config.withDefault("localhost"),
    )
    const port = yield* Config.Number("POSTGRES_PORT").pipe(
      Config.withDefault(5432),
    )
    return `postgresql://${username}@${host}:${port}/${database}`
  }),
)

/**
 * Creates a live Database layer for PostgreSQL.
 *
 * This is the production implementation that uses a real PostgreSQL database.
 * Also provides DatabaseConnectionInfo service with the connection string for logging.
 *
 * @example
 * ```typescript
 * import { DatabaseLive } from "@pf/service-drizzle-postgres"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function* () {
 *   // Your database operations here
 * })
 *
 * Effect.runPromise(program.pipe(Effect.provide(DatabaseLive)))
 * ```
 */
const PgLive = PgClient.layerConfig({
  // Preserve the v3 node-pg unnamed-query planning (partial-index upserts).
  prepare: Config.succeed(false),
  password: Config.Redacted("POSTGRES_PASSWORD"),
  username: Config.withDefault(Config.String("POSTGRES_USERNAME"), "postgres"),
  database: Config.withDefault(Config.String("POSTGRES_DATABASE"), "postgres"),
  host: Config.withDefault(Config.String("POSTGRES_HOST"), "localhost"),
  port: Config.withDefault(Config.Number("POSTGRES_PORT"), 5432),
})

export const DatabaseLive = Layer.mergeAll(PgLive, ConnectionInfoLayer)
