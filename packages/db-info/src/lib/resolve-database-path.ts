import { join, resolve } from "node:path"
import * as Config from "effect/Config"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Layer from "effect/Layer"

/**
 * Resolve SQLite database path from environment variables.
 *
 * Resolution priority:
 * 1. SQLITE_DATABASE_PATH (always wins)
 * 2. $orgPath/db/pf.db (derived from orgPath parameter or PF_ORG env var)
 * 3. Error
 *
 * The orgPath/PF_ORG value is always resolved to an absolute path because:
 * - drizzle-kit runs with cwd set to the package directory, not workspace root
 * - libsql interprets relative paths in file:// URLs as hostnames
 *
 * @param orgPath - Optional explicit org path (takes precedence over PF_ORG env var)
 * @returns Resolved absolute database path, or undefined if neither source is available
 */
export const resolveDatabasePath = (orgPath?: string): string | undefined => {
  const envPath = process.env["SQLITE_DATABASE_PATH"]
  if (envPath) return envPath

  const org = orgPath ?? process.env["PF_ORG"]
  if (!org) return undefined

  return join(resolve(org), "db", "pf.db")
}

/**
 * Effect Config that resolves the database path.
 *
 * Prefers SQLITE_DATABASE_PATH, falls back to $PF_ORG/db/pf.db.
 * PF_ORG is resolved to an absolute path so libsql file:// URLs work correctly.
 *
 * Use this in Effect layers instead of reading process.env directly.
 */
export const DatabasePathConfig: Config.Config<string> = Config.string(
  "SQLITE_DATABASE_PATH",
).pipe(
  Config.orElse(() =>
    Config.string("PF_ORG").pipe(
      Config.map((org) => join(resolve(org), "db", "pf.db")),
    ),
  ),
)

/**
 * Standardized error message for missing database path configuration.
 */
export const DATABASE_PATH_NOT_CONFIGURED =
  "Database path not configured. Set SQLITE_DATABASE_PATH or PF_ORG environment variable."

/**
 * Creates a Layer that provides a ConfigProvider with the given database path.
 * Use this in CLI commands to pass the resolved database path to downstream
 * Effect layers without mutating process.env.
 */
export const makeDatabaseConfigLayer = (databasePath: string) =>
  Layer.setConfigProvider(
    ConfigProvider.fromMap(
      new Map([["SQLITE_DATABASE_PATH", databasePath]]),
    ).pipe(ConfigProvider.orElse(() => ConfigProvider.fromEnv())),
  )
