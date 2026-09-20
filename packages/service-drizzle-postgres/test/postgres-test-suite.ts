import { randomUUID } from "node:crypto"
import { SqlClient } from "@effect/sql"
import { PgClient } from "@effect/sql-pg"
import { PostgreSqlContainer } from "@testcontainers/postgresql"
import { Context, Effect, Layer, Redacted } from "effect"
import { TypedPostgresDrizzleLayer } from "../src/lib/typed-drizzle"
import { MigrationLayer } from "./migrator"
import {
  ContainerError,
  POSTGRES_TEST_IMAGE,
} from "./postgres-alpine-container"

const templateDatabase = "pf_test_template"
const adminDatabase = "postgres"
const databaseNamePattern = /^[a-z][a-z0-9_]{0,62}$/

export interface PostgresTestSuiteConfig {
  readonly adminConnectionUri: string
  readonly templateDatabase: string
}

class ClonedDatabase extends Context.Tag(
  "@pf/service-drizzle-postgres/ClonedDatabase",
)<ClonedDatabase, { readonly connectionUri: string }>() {}

const connectionUriForDatabase = (
  connectionUri: string,
  database: string,
): string => {
  const url = new URL(connectionUri)
  url.pathname = `/${database}`
  return url.toString()
}

const connectionLayer = (connectionUri: string) =>
  PgClient.layer({
    url: Redacted.make(connectionUri),
  })

const testConnectionLayer = (connectionUri: string) => {
  const url = new URL(connectionUri)
  url.searchParams.set("options", "-c statement_timeout=5000")
  return connectionLayer(url.toString())
}

const quoteDatabaseName = (database: string): string => {
  if (!databaseNamePattern.test(database)) {
    throw new TypeError(`Invalid PostgreSQL test database name: ${database}`)
  }
  return `"${database}"`
}

const migrateTemplate = (connectionUri: string) => {
  const drizzleLayer = TypedPostgresDrizzleLayer.pipe(
    Layer.provideMerge(testConnectionLayer(connectionUri)),
  )
  // Close the migration pool before PostgreSQL uses this database as a template.
  return Layer.build(
    MigrationLayer.pipe(Layer.provideMerge(drizzleLayer)),
  ).pipe(Effect.scoped, Effect.asVoid)
}

export const PostgresTestSuite = Effect.acquireRelease(
  Effect.tryPromise({
    try: () =>
      new PostgreSqlContainer(POSTGRES_TEST_IMAGE)
        .withDatabase(templateDatabase)
        .start(),
    catch: (cause) => new ContainerError({ cause }),
  }),
  (container) => Effect.promise(() => container.stop()),
).pipe(
  Effect.tap((container) => migrateTemplate(container.getConnectionUri())),
  Effect.map(
    (container): PostgresTestSuiteConfig => ({
      adminConnectionUri: connectionUriForDatabase(
        container.getConnectionUri(),
        adminDatabase,
      ),
      templateDatabase,
    }),
  ),
)

const createClonedDatabase = (config: PostgresTestSuiteConfig) => {
  const database = `pf_test_${randomUUID().replaceAll("-", "")}`
  const createStatement = `CREATE DATABASE ${quoteDatabaseName(database)} TEMPLATE ${quoteDatabaseName(config.templateDatabase)}`

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(createStatement)
    return {
      connectionUri: connectionUriForDatabase(
        config.adminConnectionUri,
        database,
      ),
      database,
    }
  }).pipe(
    Effect.provide(connectionLayer(config.adminConnectionUri)),
    Effect.scoped,
  )
}

const dropClonedDatabase = (
  config: PostgresTestSuiteConfig,
  database: string,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(
      `DROP DATABASE IF EXISTS ${quoteDatabaseName(database)} WITH (FORCE)`,
    )
  }).pipe(
    Effect.provide(connectionLayer(config.adminConnectionUri)),
    Effect.scoped,
  )

export const postgresTestFromTemplate = (config: PostgresTestSuiteConfig) => {
  const clonedDatabaseLayer = Layer.scoped(
    ClonedDatabase,
    Effect.acquireRelease(createClonedDatabase(config), ({ database }) =>
      dropClonedDatabase(config, database).pipe(
        Effect.catchAllCause((cause) =>
          Effect.logError("Failed to drop PostgreSQL test database", cause),
        ),
      ),
    ),
  )
  const clientLayer = Layer.unwrapEffect(
    Effect.map(ClonedDatabase, ({ connectionUri }) =>
      testConnectionLayer(connectionUri),
    ),
  ).pipe(Layer.provide(clonedDatabaseLayer))

  return TypedPostgresDrizzleLayer.pipe(Layer.provideMerge(clientLayer))
}
