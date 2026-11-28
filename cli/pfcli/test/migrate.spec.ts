import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber, Layer, Result } from "effect"
import * as Reactivity from "effect/reactivity/Reactivity"
import * as SqlClient from "effect/sql/SqlClient"
import { SqlError, UnknownError } from "effect/sql/SqlError"
import { makeCompilerSqlite } from "effect/sql/Statement"
import { TestClock } from "effect/testing"
import { makeDatabaseConfigLayer } from "@pf/db-info"
import { makeTursoLive } from "@pf/layer-turso-local"
import {
  executeMigrationStatements,
  runDrizzleMigrations,
} from "../src/utils/migration-layer"
import { cleanupTestDatabase } from "./cleanup-test-database"
import {
  DEMO_ORG,
  captureStdout,
  copySharedBuiltDemoArtifact,
  loadPfcliCommand,
  readStoredFrontendJwtFromDatabasePath,
  runPfcliInProcess,
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
    for (const p of dbPaths) cleanupTestDatabase(p)
    dbPaths.length = 0

    for (const p of tempOrgPaths) {
      rmSync(p, { recursive: true, force: true })
    }
    tempOrgPaths.length = 0
  })

  it.each([false, true])(
    "persists system and custom migrations and leaves them unchanged on rerun (explicit path: %s)",
    async (explicit) => {
      const dbPath = makeDbPath()
      dbPaths.push(dbPath)
      const { runMigrate } = await loadPfcliCommand<{ runMigrate: RunMigrate }>(
        "migrate",
      )

      const readPersistedState = () => {
        // Use a fresh reader after the migrator connection closes: Turso
        // multiprocess_wal previously lost writes after pragma_table_info(?).
        const db = new Database(dbPath, { readonly: true })
        try {
          const journals = [
            "__drizzle_migrations_pf",
            "__drizzle_migrations_org",
          ].map((table) => ({
            columns: db
              .query<{ name: string }, []>(`PRAGMA table_info('${table}')`)
              .all()
              .map((row) => row.name),
            count: db
              .query<{ c: number }, []>(`SELECT count(*) AS c FROM ${table}`)
              .get()?.c,
          }))
          const invitationColumns = db
            .query<{ name: string }, []>("PRAGMA table_info(pf_invitation)")
            .all()
            .map((row) => row.name)
          return { journals, invitationColumns }
        } finally {
          db.close()
        }
      }

      await withEnv(
        { SQLITE_DATABASE_PATH: explicit ? "/nonexistent/ignored.db" : dbPath },
        async () => {
          const { output } = explicit
            ? await runPfcliInProcess([
                "migrate",
                DEMO_ORG,
                "--database-path",
                dbPath,
              ])
            : await captureStdout(() =>
                runWithNodeContext(runMigrate(DEMO_ORG)),
              )
          expect(output).toContain("System migrations completed")

          const persisted = readPersistedState()
          for (const journal of persisted.journals) {
            expect(journal.columns).toEqual(
              expect.arrayContaining(["name", "applied_at"]),
            )
            expect(journal.count).toBeGreaterThan(0)
          }
          expect(persisted.invitationColumns).toContain(
            "invitation_pending_email",
          )

          if (explicit) {
            const rerun = await runPfcliInProcess([
              "migrate",
              DEMO_ORG,
              "--database-path",
              dbPath,
            ])
            expect(rerun.status).toBe(0)
          } else {
            await runWithNodeContext(runMigrate(DEMO_ORG))
          }
          expect(readPersistedState()).toEqual(persisted)
        },
      )
    },
    60_000,
  )

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

  it.each([
    { code: "TIMEOUT", failures: 1, attempts: 2, succeeds: true },
    { code: "TIMEOUT", failures: 2, attempts: 2, succeeds: false },
    { code: "SQLITE_ERROR", failures: 1, attempts: 1, succeeds: false },
  ])(
    "handles $code on migration journal creation ($failures failures)",
    async ({ code, failures, attempts, succeeds }) => {
      const directory = mkdtempSync(join(tmpdir(), "pfcli-journal-retry-"))
      tempOrgPaths.push(directory)
      const databasePath = makeDbPath()
      dbPaths.push(databasePath)
      const migrationsTable = "__drizzle_migrations_pf"
      const cause = Object.assign(new Error("Injected statement failure"), {
        code,
      })
      const sqlError = new SqlError({
        reason: new UnknownError({
          cause,
          message: "Failed to execute statement",
        }),
      })
      let creates = 0

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const local = yield* SqlClient.SqlClient
          const client = yield* SqlClient.make({
            driver: local.driver,
            compiler: makeCompilerSqlite(),
            spanAttributes: [],
            acquirer: local.reserve.pipe(
              Effect.map((connection) => ({
                ...connection,
                execute: (sql, params, transformRows) =>
                  connection
                    .execute(sql, params, transformRows)
                    .pipe(
                      Effect.tap(() =>
                        sql.startsWith(
                          `CREATE TABLE IF NOT EXISTS "${migrationsTable}"`,
                        ) && ++creates <= failures
                          ? Effect.fail(sqlError)
                          : Effect.void,
                      ),
                    ),
              })),
            ),
          })
          // Fail after SQLite executed the statement, as a lost reply might.
          const fiber = yield* Effect.forkChild(
            runDrizzleMigrations({
              migrationsFolder: directory,
              migrationsTable,
            }).pipe(
              Effect.provideService(SqlClient.SqlClient, client),
              Effect.result,
            ),
          )
          yield* TestClock.adjust("5 seconds")
          return yield* Fiber.join(fiber)
        }).pipe(
          Effect.provide(Reactivity.layer),
          Effect.provide(TestClock.layer()),
          Effect.provide(
            makeTursoLive().pipe(
              Layer.provide(makeDatabaseConfigLayer(databasePath)),
            ),
          ),
        ),
      )

      expect(creates).toBe(attempts)
      expect(Result.isSuccess(result)).toBe(succeeds)
      if (Result.isFailure(result)) {
        expect(result.failure.cause).toBe(sqlError)
      }
    },
  )

  it.each([false, true])(
    "imports into a fresh database and creates a JWT (explicit inputs: %s)",
    async (explicit) => {
      const dbPath = makeDbPath()
      const orgRoot = mkdtempSync(join(tmpdir(), "test-pfcli-migrate-org-"))
      dbPaths.push(dbPath)
      tempOrgPaths.push(orgRoot)
      const { runImport } = await loadPfcliCommand<{ runImport: RunImport }>(
        "import",
      )

      await copySharedBuiltDemoArtifact(orgRoot)

      await withEnv(
        {
          SQLITE_DATABASE_PATH: explicit ? "/nonexistent/ignored.db" : dbPath,
          ...baseEnv,
        },
        async () => {
          const { output } = explicit
            ? await runPfcliInProcess([
                "import",
                orgRoot,
                "--database-path",
                dbPath,
                "--issuer-url",
                "https://auth.example.com",
              ])
            : await captureStdout(() => runWithNodeContext(runImport(orgRoot)))

          const db = new Database(dbPath, { readonly: true })
          const tables = db
            .query<{ name: string }, []>(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations_pf'",
            )
            .all()
          db.close()

          expect(output).toContain("Database import completed")
          expect(tables).toHaveLength(1)
          const token = await readStoredFrontendJwtFromDatabasePath(dbPath)
          expect(token).toBeDefined()
          const claims = JSON.parse(
            Buffer.from(token!.split(".")[1]!, "base64url").toString(),
          )
          expect(claims.iss).toBe(
            explicit ? "https://auth.example.com" : baseEnv.OAUTH_ISSUER_URL,
          )

          if (explicit) {
            const refreshed = await runPfcliInProcess([
              "refresh-frontend-jwt",
              orgRoot,
              "--database-path",
              dbPath,
              "--issuer-url",
              "https://new-auth.example.com",
            ])
            expect(refreshed.status).toBe(0)
            const updated = await readStoredFrontendJwtFromDatabasePath(dbPath)
            expect(
              JSON.parse(
                Buffer.from(updated!.split(".")[1]!, "base64url").toString(),
              ).iss,
            ).toBe("https://new-auth.example.com")
            const read = await runPfcliInProcess([
              "get-frontend-jwt",
              orgRoot,
              "--database-path",
              dbPath,
            ])
            expect(read.status).toBe(0)
            expect(read.output).toContain(updated!)
          }
        },
      )
    },
    60_000,
  )
})
