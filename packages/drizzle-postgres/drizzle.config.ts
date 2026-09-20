import { defineConfig } from "drizzle-kit"

export default defineConfig({
  schema: "./src/lib/db-schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  // Use separate table to avoid collisions with org schema migrations
  migrations: { table: "__drizzle_migrations_pf" },
})
