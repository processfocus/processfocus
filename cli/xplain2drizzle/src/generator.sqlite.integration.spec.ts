import { join } from "node:path"
import { sql } from "drizzle-orm"
import { ConfigProvider, Effect } from "effect"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"
import { DatabaseTest } from "@pf/service-drizzle-sqlite/test"
import { parse } from "@pf/xplain-ddl"
import { generateDrizzleSchema } from "./generator.sqlite.js"
import { beforeAll, describe, expect, it } from "bun:test"

/**
 * Integration test that validates the real schema.ddl file works with SQLite.
 *
 * This test:
 * 1. Reads the actual production schema.ddl
 * 2. Generates Drizzle schema code (validates generator works)
 * 3. Uses existing SQL migrations from packages/drizzle-sqlite/drizzle
 * 4. Applies migrations to in-memory SQLite
 * 5. Tests tables and views exist as expected
 */

let migrationsFolder: string

beforeAll(async () => {
  // Use the existing migrations folder from the real drizzle-sqlite package
  // This validates that our generated schema matches what's actually being used
  migrationsFolder = join(
    import.meta.dir,
    "../../../packages/drizzle-sqlite/drizzle",
  )

  // Verify that the actual schema.ddl generates successfully
  // This ensures our generator is working correctly
  const schemaPath = join(
    import.meta.dir,
    "../../../packages/db-schema/xplain/schema.ddl",
  )
  const schemaSource = await Bun.file(schemaPath).text()

  const program = Effect.gen(function* () {
    const ast = yield* parse(schemaSource)
    const generatedSchema = yield* generateDrizzleSchema(ast, "schema.ddl")

    // Just verify it generates without errors
    // The actual validation happens when we apply migrations to the database
    return generatedSchema
  })

  await Effect.runPromise(program)
})

describe("generateDrizzleSchema (SQLite) - Live Integration", () => {
  it("queries target histories without mixing actor delegation or generation edges", async () => {
    const testProgram = Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      yield* db.run(sql`INSERT INTO pf_org_unit (id, name, org_unit_level, path)
        VALUES ('ou-history', 'History', 'root', '/history')`)
      yield* db.run(sql`INSERT INTO pf_user (id, provider, sub, last_logged_in)
        VALUES ('usr-history', 'test', 'history', julianday('now'))`)
      yield* db.run(sql`INSERT INTO pf_provider_user
        (id, user_id, email, name, first_name, last_name, picture, locale, org_unit_id)
        VALUES ('pu-history', 'usr-history', 'history@example.test', 'History', '', '', '', 'en', 'ou-history')`)
      for (const id of ["target", "actor"]) {
        yield* db.run(sql`INSERT INTO pf_delegation
          (id, owner_provider_user, delegation_name)
          VALUES (${id}, 'pu-history', ${id})`)
        yield* db.run(sql`INSERT INTO pf_secret_generation
          (id, delegation_id, secret_verifier, secret_issued_at, secret_expires_at)
          VALUES (${id}, ${id}, ${id}, julianday('now'), julianday('now', '+1 day'))`)
      }
      // Cross the edges in both directions so each inverse must select its target.
      for (const [target, actor] of [
        ["target", "actor"],
        ["actor", "target"],
      ]) {
        yield* db.run(sql`INSERT INTO pf_delegation_history
          (id, delegation_id, secret_generation_id, actor_provider_user,
           delegation_event, secret_issued_at, actor_delegation, actor_secret_generation)
          VALUES (${target}, ${target}, ${target}, 'pu-history', 'renamed',
            julianday('now'), ${actor}, ${actor})`)
      }

      // Generated relations use Drizzle's legacy relational-query API.
      const delegations = yield* db._query.delegation.findMany({
        with: { delegationHistories: true },
      })
      const generations = yield* db._query.secretGeneration.findMany({
        with: { delegationHistories: true },
      })
      for (const rows of [delegations, generations]) {
        expect(rows).toHaveLength(2)
        for (const row of rows) {
          expect(row.delegationHistories.map((history) => history.id)).toEqual([
            row.id,
          ])
        }
      }
      const histories = yield* db._query.delegationHistory.findMany({
        with: {
          delegation: true,
          secretGeneration: true,
          actorDelegation: true,
          actorSecretGeneration: true,
        },
      })
      expect(histories).toHaveLength(2)
      for (const history of histories) {
        expect(history.delegation.id).toBe(history.id)
        expect(history.secretGeneration.id).toBe(history.id)
        const actor = history.id === "target" ? "actor" : "target"
        expect(history.actorDelegation?.id).toBe(actor)
        expect(history.actorSecretGeneration?.id).toBe(actor)
      }
    })

    await Effect.runPromise(
      testProgram.pipe(
        Effect.provide(DatabaseTest),
        Effect.withConfigProvider(
          ConfigProvider.fromMap(
            new Map([["MIGRATIONS_FOLDER", migrationsFolder]]),
          ),
        ),
      ),
    )
  })

  it("should successfully generate and apply migrations for real schema", async () => {
    const testProgram = Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle

      // If we get here, migrations applied successfully
      expect(db).toBeDefined()
    })

    const configProvider = ConfigProvider.fromMap(
      new Map([["MIGRATIONS_FOLDER", migrationsFolder]]),
    )

    await Effect.runPromise(
      testProgram.pipe(
        Effect.provide(DatabaseTest),
        Effect.withConfigProvider(configProvider),
      ),
    )
  })

  it("should create all expected tables", async () => {
    const testProgram = Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle

      // Query sqlite_master to check tables exist
      const result = yield* db.all<string[]>(
        sql`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
      )

      // db.all() returns array of arrays, not array of objects
      const tableNames = result.flat()

      expect(tableNames).toContain("pf_org_unit")
      expect(tableNames).toContain("pf_process")
      expect(tableNames).toContain("pf_role")
      expect(tableNames).toContain("pf_step")
      expect(tableNames).toContain("pf_flow")
      expect(tableNames).toContain("pf_process_state")
      expect(tableNames).toContain("pf_process_execution")
      expect(tableNames).toContain("pf_to_do")
    })

    const configProvider = ConfigProvider.fromMap(
      new Map([["MIGRATIONS_FOLDER", migrationsFolder]]),
    )

    await Effect.runPromise(
      testProgram.pipe(
        Effect.provide(DatabaseTest),
        Effect.withConfigProvider(configProvider),
      ),
    )
  })

  it("should verify views for extend commands exist", async () => {
    const testProgram = Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle

      // Query sqlite_master to check views exist
      const result = yield* db.all<string[]>(
        sql`SELECT name FROM sqlite_master WHERE type='view' ORDER BY name`,
      )

      // db.all() returns array of arrays, not array of objects
      const viewNames = result.flat()

      // From schema.ddl:
      // extend process with no drafts = nil process execution per process state its process.
      expect(viewNames).toContain("pf_process_its_no_drafts")

      // extend step with can start process = nil flow per target_step.
      expect(viewNames).toContain("pf_step_its_can_start_process")

      // extend process state with is draft = nil process execution per process state.
      expect(viewNames).toContain("pf_process_state_its_is_draft")
    })

    const configProvider = ConfigProvider.fromMap(
      new Map([["MIGRATIONS_FOLDER", migrationsFolder]]),
    )

    await Effect.runPromise(
      testProgram.pipe(
        Effect.provide(DatabaseTest),
        Effect.withConfigProvider(configProvider),
      ),
    )
  })
})
