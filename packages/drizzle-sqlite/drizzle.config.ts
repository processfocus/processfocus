import { existsSync, mkdirSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { defineConfig } from "drizzle-kit"

// Workspace root for resolving relative PF_ORG paths.
// Nx sets NX_WORKSPACE_ROOT automatically. When running outside Nx
// (not recommended), process.cwd() is used as fallback — ensure you
// run from the workspace root or use absolute paths.
const workspaceRoot = process.env.NX_WORKSPACE_ROOT ?? process.cwd()

// Resolve PF_ORG relative to workspace root, not project cwd
const resolvePfOrg = (pfOrg: string) =>
  isAbsolute(pfOrg) ? pfOrg : resolve(workspaceRoot, pfOrg)

// Resolve database path: SQLITE_DATABASE_PATH > $PF_ORG/db/pf.db > error
const dbPath =
  process.env.SQLITE_DATABASE_PATH ??
  (process.env.PF_ORG
    ? join(resolvePfOrg(process.env.PF_ORG), "db", "pf.db")
    : undefined)

if (!dbPath) {
  throw new Error(
    "Database path not configured. Set SQLITE_DATABASE_PATH or PF_ORG environment variable.\n" +
      "  File: packages/drizzle-sqlite/drizzle.config.ts\n" +
      "  Example: export PF_ORG=examples/demo\n" +
      "           export SQLITE_DATABASE_PATH=/path/to/database.db",
  )
}

// Parse the URL to determine protocol
// If no protocol, treat as file path
let parsedUrl: URL
try {
  parsedUrl = new URL(dbPath)
} catch {
  // Not a valid URL, treat as file path
  parsedUrl = pathToFileURL(dbPath)
}

const dbUrl = parsedUrl.href

// Ensure database directory exists for local file paths.
// Needed because drizzle-kit migrate will attempt to open/create the database file.
if (parsedUrl.protocol === "file:") {
  const fsPath = fileURLToPath(parsedUrl)
  const dir = dirname(fsPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`Created database directory: ${dir}`)
  }
}

console.log(`Database: ${dbUrl}`)

// Use "turso" dialect for remote Turso databases (libsql://),
// "sqlite" for local files (file://)
const isRemote = parsedUrl.protocol === "libsql:"
const dialect = isRemote ? "turso" : "sqlite"
let authToken: string | undefined
if (isRemote) {
  authToken = process.env.TURSO_AUTH_TOKEN
  if (!authToken) {
    throw new Error("TURSO_AUTH_TOKEN is required for remote Turso databases")
  }
}

export default defineConfig({
  schema: "./src/lib/db-schema.ts",
  out: "./drizzle",
  dialect,
  // Use separate table to avoid collisions with org schema migrations
  migrations: { table: "__drizzle_migrations_pf" },
  dbCredentials: {
    url: dbUrl,
    ...(authToken && { authToken }),
  },
})
