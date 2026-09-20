import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { FileSystem } from "@effect/platform"
import { Console, Effect } from "effect"
import {
  DATABASE_PATH_NOT_CONFIGURED,
  isLocalFilePath,
  resolveDatabasePath,
} from "@pf/db-info"
import { MigrationError } from "../errors"
import {
  makeMigrationLayer,
  runDrizzleMigrations,
} from "../utils/migration-layer"
import { runMigrateCustom } from "./migrate-custom"

declare const PFCLI_DISTRIBUTION_BUILD: boolean

const SYSTEM_MIGRATIONS_FOLDER = fileURLToPath(
  typeof PFCLI_DISTRIBUTION_BUILD === "undefined"
    ? new URL("../../../../packages/drizzle-sqlite/drizzle/", import.meta.url)
    : new URL("./resources/system-migrations/", import.meta.url),
)

/**
 * Run both system and org migrations.
 *
 * 1. System migrations (table `__drizzle_migrations_pf`)
 * 2. Org custom migrations via `runMigrateCustom` (NoDrizzleConfigError silenced)
 *
 * Fails with MigrationError on failure — callers decide how to handle it.
 *
 * @param orgPath - Path to organisation directory
 */
export const runMigrate = (orgPath: string) =>
  Effect.gen(function* () {
    const databasePath = resolveDatabasePath(orgPath)

    if (!databasePath) {
      // return needed for type narrowing in Effect.gen
      return yield* new MigrationError({
        reason: DATABASE_PATH_NOT_CONFIGURED,
        cause: undefined,
      })
    }

    // Validate system migrations folder exists
    const fs = yield* FileSystem.FileSystem

    if (isLocalFilePath(databasePath)) {
      const localDatabasePath = databasePath.startsWith("file:")
        ? fileURLToPath(new URL(databasePath))
        : databasePath
      yield* fs.makeDirectory(path.dirname(localDatabasePath), {
        recursive: true,
      })
    }

    const folderExists = yield* fs.exists(SYSTEM_MIGRATIONS_FOLDER)
    if (!folderExists) {
      // return needed for type narrowing in Effect.gen
      return yield* new MigrationError({
        reason: `System migrations folder not found: ${SYSTEM_MIGRATIONS_FOLDER}`,
        cause: undefined,
      })
    }

    yield* Console.log("Running system migrations...")
    yield* Console.log(`Database: ${databasePath}`)

    const appLayer = makeMigrationLayer(databasePath)

    // Run system migrations
    yield* runDrizzleMigrations({
      migrationsFolder: SYSTEM_MIGRATIONS_FOLDER,
      migrationsTable: "__drizzle_migrations_pf",
    }).pipe(
      Effect.tap(() => Console.log("✅ System migrations completed")),
      Effect.provide(appLayer),
    )

    // Run org custom migrations (silently skip if no drizzle config)
    yield* runMigrateCustom(orgPath).pipe(
      Effect.catchTag("NoDrizzleConfigError", () => Effect.void),
    )
  })
