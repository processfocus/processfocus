import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Config, Effect, Layer } from "effect"
import { SqliteTest } from "@pf/layer-sqlite-bun"
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

/* Build test database using a layer. Layers act as constructors for
 * creating the service, allowing us to handle dependencies at the
 * construction level rather than the service level.
 */
const DrizzleTest = TypedSqliteDrizzleLayer.pipe(Layer.provide(SqliteTest))

const MigrationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const migrationsFolder = yield* MigrationsFolderConfig
    yield* runSqliteTestMigrations(migrationsFolder)
  }),
)

export const DatabaseTest = MigrationLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(SqliteTest, DrizzleTest)),
)

export * from "./typed-drizzle"
