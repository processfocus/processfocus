import * as path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Absolute path to the system migrations folder (`drizzle/`).
 * Resolved relative to this source file so it survives bundling
 * as long as `@pf/drizzle-sqlite` imports are resolved by the bundler.
 */
export const SYSTEM_MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
)
