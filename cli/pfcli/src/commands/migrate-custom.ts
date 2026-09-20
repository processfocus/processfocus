import * as path from "node:path"
import { FileSystem } from "@effect/platform"
import { Console, Data, Effect } from "effect"
import { DATABASE_PATH_NOT_CONFIGURED, resolveDatabasePath } from "@pf/db-info"
import { MigrationError } from "../errors"
import {
  makeMigrationLayer,
  runDrizzleMigrations,
} from "../utils/migration-layer"

export { MigrationError }

/**
 * Convention-based paths for custom schema.
 */
const DRIZZLE_CONFIG = "drizzle.config.ts"
const MIGRATIONS_FOLDER = "drizzle"

/**
 * Error thrown when drizzle.config.ts is not found.
 */
export class NoDrizzleConfigError extends Data.TaggedError(
  "NoDrizzleConfigError",
)<{
  readonly orgPath: string
}> {}

/**
 * Run custom schema migrations for an organisation.
 *
 * Uses convention-based detection:
 * - Checks for drizzle.config.ts at org root
 * - Runs migrations from drizzle/ folder
 *
 * @param orgPath - Path to organisation directory
 */
export const runMigrateCustom = (orgPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    // Resolve database path using shared utility
    const databasePath = resolveDatabasePath(orgPath)

    if (!databasePath) {
      // return needed for type narrowing in Effect.gen
      return yield* new MigrationError({
        reason: DATABASE_PATH_NOT_CONFIGURED,
        cause: undefined,
      })
    }

    // Resolve to absolute path
    const resolvedPath = path.resolve(process.cwd(), orgPath)

    // Check for drizzle.config.ts (convention-based detection)
    const drizzleConfigPath = path.join(resolvedPath, DRIZZLE_CONFIG)
    const hasCustomSchema = yield* fs.exists(drizzleConfigPath)

    if (!hasCustomSchema) {
      return yield* new NoDrizzleConfigError({ orgPath: resolvedPath })
    }

    // Resolve migrations folder (convention: drizzle/)
    const migrationsFolder = path.join(resolvedPath, MIGRATIONS_FOLDER)

    // Verify migrations folder exists
    const folderExists = yield* fs.exists(migrationsFolder)
    if (!folderExists) {
      yield* Console.log(
        `Migrations folder not found: ${migrationsFolder}. Run 'bunx drizzle-kit generate' first.`,
      )
      return
    }

    yield* Console.log(`Running custom migrations from: ${migrationsFolder}`)
    yield* Console.log(`Database: ${databasePath}`)

    const appLayer = makeMigrationLayer(databasePath)

    // Run migrations
    yield* runDrizzleMigrations({
      migrationsFolder,
      migrationsTable: "__drizzle_migrations_org",
    }).pipe(
      Effect.tap(() => Console.log("✅ Custom schema migrations completed")),
      Effect.provide(appLayer),
    )
  })
