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
    const username = yield* Config.string("POSTGRES_USERNAME").pipe(
      Config.withDefault("postgres"),
    )
    const database = yield* Config.string("POSTGRES_DATABASE").pipe(
      Config.withDefault("postgres"),
    )
    const host = yield* Config.string("POSTGRES_HOST").pipe(
      Config.withDefault("localhost"),
    )
    const port = yield* Config.number("POSTGRES_PORT").pipe(
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
  password: Config.redacted("POSTGRES_PASSWORD"),
  username: Config.withDefault(Config.string("POSTGRES_USERNAME"), "postgres"),
  database: Config.withDefault(Config.string("POSTGRES_DATABASE"), "postgres"),
  host: Config.withDefault(Config.string("POSTGRES_HOST"), "localhost"),
  port: Config.withDefault(Config.number("POSTGRES_PORT"), 5432),
})

export const DatabaseLive = Layer.mergeAll(PgLive, ConnectionInfoLayer)
