import * as path from "node:path"
import { Console, Data, Effect, FileSystem } from "effect"
import { DATABASE_PATH_NOT_CONFIGURED, resolveDatabasePath } from "@pf/db-info"
import { MigrationError } from "../errors"
import {
  makeMigrationLayer,
  runDrizzleMigrations,
} from "../utils/migration-layer"
import type { DatabaseOptions } from "../utils/operator-inputs"

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
export const runMigrateCustom = (
  orgPath: string,
  options: DatabaseOptions = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const databasePath = options.databasePath ?? resolveDatabasePath(orgPath)

    if (!databasePath) {
      // return needed for type narrowing in Effect.gen
      return yield* new MigrationError({
        reason: DATABASE_PATH_NOT_CONFIGURED,
        cause: undefined,
      })
    }

    const resolvedPath = path.resolve(process.cwd(), orgPath)

    const drizzleConfigPath = path.join(resolvedPath, DRIZZLE_CONFIG)
    const hasCustomSchema = yield* fs.exists(drizzleConfigPath)

    if (!hasCustomSchema) {
      return yield* new NoDrizzleConfigError({ orgPath: resolvedPath })
    }

    const migrationsFolder = path.join(resolvedPath, MIGRATIONS_FOLDER)

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

    yield* runDrizzleMigrations({
      migrationsFolder,
      migrationsTable: "__drizzle_migrations_org",
    }).pipe(
      Effect.tap(() => Console.log("✅ Custom schema migrations completed")),
      Effect.provide(appLayer),
    )
  })
