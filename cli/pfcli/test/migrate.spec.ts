import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as SqlClient from "@effect/sql/SqlClient"
import { Effect, Layer } from "effect"
import { makeDatabaseConfigLayer } from "@pf/db-info"
import { makeTursoLive } from "@pf/layer-turso-local"
import { executeMigrationStatements } from "../src/utils/migration-layer"
import {
  DEMO_ORG,
  captureStdout,
  copySharedBuiltDemoArtifact,
  loadPfcliCommand,
  readStoredFrontendJwtFromDatabasePath,
  runWithNodeContext,
  useSerializedTestState,
  withEnv,
} from "./test-helpers"
import Database from "bun:sqlite"
import { afterEach, describe, expect, it } from "bun:test"

const randomSuffix = () => Math.random().toString(36).substring(2, 8)

useSerializedTestState()

const makeDbPath = () =>
  join(tmpdir(), `test-pfcli-migrate-${Date.now()}-${randomSuffix()}.db`)

const cleanupDb = (dbPath: string) => {
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${dbPath}${suffix}`
    if (existsSync(file)) unlinkSync(file)
  }
}

type RunImport = (orgPath: string) => import("effect").Effect.Effect<unknown>
type RunMigrate = (orgPath: string) => import("effect").Effect.Effect<unknown>

const baseEnv = {
  GOOGLE_CLIENT_ID: process.env["GOOGLE_CLIENT_ID"] || "test-client-id",
  GOOGLE_CLIENT_SECRET:
    process.env["GOOGLE_CLIENT_SECRET"] || "test-client-secret",
  CI_PIPELINE_SECRET:
    process.env["CI_PIPELINE_SECRET"] || "test-pipeline-secret",
  GRAPHQL_SERVER_URL: "http://localhost:1",
  OAUTH_ISSUER_URL: "http://localhost:4020",
}

describe("pfcli migrate", () => {
  const dbPaths: string[] = []
  const tempOrgPaths: string[] = []

  afterEach(() => {
    for (const p of dbPaths) cleanupDb(p)
    dbPaths.length = 0

    for (const p of tempOrgPaths) {
      rmSync(p, { recursive: true, force: true })
    }
    tempOrgPaths.length = 0
  })

  it("creates system migration table on a fresh database", () => {
    const dbPath = makeDbPath()
    dbPaths.push(dbPath)

    return withEnv({ SQLITE_DATABASE_PATH: dbPath }, async () => {
      const { runMigrate } = await loadPfcliCommand<{ runMigrate: RunMigrate }>(
        "migrate",
      )
      const { output } = await captureStdout(() =>
        runWithNodeContext(runMigrate(DEMO_ORG)),
      )

      const db = new Database(dbPath, { readonly: true })
      const tables = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations_pf'",
        )
        .all()
      db.close()

      expect(output).toContain("System migrations completed")
      expect(tables).toHaveLength(1)
    })
  }, 60_000)

  it("is idempotent — running twice succeeds", async () => {
    const dbPath = makeDbPath()
    dbPaths.push(dbPath)
    const { runMigrate } = await loadPfcliCommand<{ runMigrate: RunMigrate }>(
      "migrate",
    )

    await withEnv({ SQLITE_DATABASE_PATH: dbPath }, async () => {
      await runWithNodeContext(runMigrate(DEMO_ORG))
      await runWithNodeContext(runMigrate(DEMO_ORG))
    })
  }, 60_000)

  it("persists system migrations across connection close", async () => {
    const dbPath = makeDbPath()
    dbPaths.push(dbPath)
    const { runMigrate } = await loadPfcliCommand<{ runMigrate: RunMigrate }>(
      "migrate",
    )

    await withEnv({ SQLITE_DATABASE_PATH: dbPath }, async () => {
      await runWithNodeContext(runMigrate(DEMO_ORG))
    })

    // Re-open with a fresh reader after the migrator connection closed.
    // Turso multiprocess_wal previously lost migration writes here when
    // drizzle-orm's migrate() ran pragma_table_info(?).
    const db = new Database(dbPath, { readonly: true })
    const migrationCount = db
      .query<{ c: number }, []>(
        "SELECT count(*) AS c FROM __drizzle_migrations_pf",
      )
      .get()?.c
    const invitationColumns = db
      .query<{ name: string }, []>("PRAGMA table_info(pf_invitation)")
      .all()
      .map((row) => row.name)
    db.close()

    expect(migrationCount).toBeGreaterThan(0)
    expect(invitationColumns).toContain("invitation_pending_email")
  }, 60_000)

  it("creates current custom migration table columns", async () => {
    const dbPath = makeDbPath()
    dbPaths.push(dbPath)

    const { runMigrate } = await loadPfcliCommand<{ runMigrate: RunMigrate }>(
      "migrate",
    )

    await withEnv({ SQLITE_DATABASE_PATH: dbPath }, async () => {
      await runWithNodeContext(runMigrate(DEMO_ORG))
    })

    const db = new Database(dbPath, { readonly: true })
    const columns = db
      .query<{ name: string }, []>(
        "PRAGMA table_info('__drizzle_migrations_org')",
      )
      .all()
      .map((row) => row.name)
    db.close()

    expect(columns).toContain("name")
    expect(columns).toContain("applied_at")
  }, 60_000)

  it("executes multi-statement migration scripts through the neutral SQL layer", async () => {
    const dbPath = makeDbPath()
    dbPaths.push(dbPath)
    const SqlLayer = makeTursoLive().pipe(
      Layer.provide(makeDatabaseConfigLayer(dbPath)),
    )

    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        yield* executeMigrationStatements([
          `CREATE TABLE neutral_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
          CREATE TRIGGER neutral_migrations_name_trigger
          AFTER UPDATE ON neutral_migrations
          FOR EACH ROW
          BEGIN
            INSERT INTO neutral_migrations (name) VALUES ('triggered; value');
            INSERT INTO neutral_migrations (name)
              VALUES (CASE WHEN NEW.name = 'case; input' THEN 'case; output' ELSE NEW.name END);
          END /* generated */;
          INSERT INTO neutral_migrations (name) VALUES ('first; still first');
          INSERT INTO neutral_migrations (name) VALUES ('CREATE TRIGGER is text');
          INSERT INTO neutral_migrations (name) VALUES ('second');`,
        ])

        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE neutral_migrations SET name = 'case; input' WHERE name = 'second'`

        return yield* sql<{ readonly name: string }>`
          SELECT name FROM neutral_migrations ORDER BY id
        `
      }).pipe(Effect.provide(SqlLayer)),
    )

    expect(rows.map((row) => row.name)).toEqual([
      "first; still first",
      "CREATE TRIGGER is text",
      "case; input",
      "triggered; value",
      "case; output",
    ])
  })

  it("import works on a fresh database without prior migration", async () => {
    const dbPath = makeDbPath()
    const orgRoot = mkdtempSync(join(tmpdir(), "test-pfcli-migrate-org-"))
    dbPaths.push(dbPath)
    tempOrgPaths.push(orgRoot)
    const { runImport } = await loadPfcliCommand<{ runImport: RunImport }>(
      "import",
    )

    await copySharedBuiltDemoArtifact(orgRoot)

    await withEnv({ SQLITE_DATABASE_PATH: dbPath, ...baseEnv }, async () => {
      const { output } = await captureStdout(() =>
        runWithNodeContext(runImport(orgRoot)),
      )

      const db = new Database(dbPath, { readonly: true })
      const tables = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations_pf'",
        )
        .all()
      db.close()

      expect(output).toContain("Database import completed")
      expect(tables).toHaveLength(1)
      expect(await readStoredFrontendJwtFromDatabasePath(dbPath)).toBeDefined()
    })
  }, 60_000)
})
