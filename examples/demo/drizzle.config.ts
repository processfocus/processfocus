import { pathToFileURL } from "node:url"
import { defineConfig } from "drizzle-kit"

const dbPath = process.env.SQLITE_DATABASE_PATH
if (!dbPath) {
  throw new Error(
    "SQLITE_DATABASE_PATH environment variable is required.\n" +
      "Please set it to the path of your SQLite database file.\n" +
      "Example: export SQLITE_DATABASE_PATH=/path/to/database.db",
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
  schema: "./src/schema/schema.ts",
  out: "./drizzle",
  dialect,
  // Use separate table to avoid collisions with core schema migrations
  migrations: { table: "__drizzle_migrations_org" },
  dbCredentials: {
    url: dbUrl,
    ...(authToken && { authToken }),
  },
})
