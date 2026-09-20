import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { sql } from "drizzle-orm"
import { readMigrationFiles } from "drizzle-orm/migrator"
import { numeric, pgSchema, serial, text } from "drizzle-orm/pg-core"
import { Effect, Layer } from "effect"
import { TypedPostgresDrizzle } from "../src/lib/typed-drizzle"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const migrationsFolder = join(__dirname, "../../drizzle-postgres/drizzle")

// Drizzle schema and migrations table for querying
const drizzleSchema = pgSchema("drizzle")
const drizzleMigrations = drizzleSchema.table("__drizzle_migrations_pf", {
  id: serial("id").primaryKey(),
  hash: text("hash").notNull(),
  created_at: numeric("created_at"),
})

export const MigrationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const db = yield* TypedPostgresDrizzle
    const execute = (query: Parameters<typeof db.execute>[0]) =>
      Effect.promise(() => Promise.resolve(db.execute(query)))

    // Read migration files
    const migrations = readMigrationFiles({ migrationsFolder })

    // Create drizzle schema and migrations table
    yield* execute(sql`CREATE SCHEMA IF NOT EXISTS "drizzle"`)

    const migrationTableCreate = sql`
      CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations_pf" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at numeric
      )
    `
    yield* execute(migrationTableCreate)

    // Query last migration using select() to avoid the execute bug
    const dbMigrations = yield* db
      .select()
      .from(drizzleMigrations)
      .orderBy(sql`created_at DESC`)
      .limit(1)

    const lastDbMigration = dbMigrations[0]

    // Determine which migrations need to run
    const queriesToRun: string[] = []
    for (const migration of migrations) {
      if (
        !lastDbMigration ||
        Number(lastDbMigration.created_at) < migration.folderMillis
      ) {
        queriesToRun.push(
          ...migration.sql,
          `INSERT INTO "drizzle"."__drizzle_migrations_pf" ("hash", "created_at") VALUES('${migration.hash}', '${migration.folderMillis}')`,
        )
      }
    }

    // Execute all pending migrations
    for (const query of queriesToRun) {
      yield* execute(sql.raw(query))
    }
  }),
)
