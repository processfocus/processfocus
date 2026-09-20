import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqlClient } from "@effect/sql"
import { readMigrationFiles } from "drizzle-orm/migrator"
import { Effect } from "effect"
import { SYSTEM_MIGRATIONS_FOLDER } from "@pf/drizzle-sqlite/migrations-path"
import {
  executeMigrationStatements,
  makeMigrationLayer,
} from "../src/utils/migration-layer"
import { describe, expect, it } from "bun:test"

const withDatabase = async (
  check: Effect.Effect<void, unknown, SqlClient.SqlClient>,
) => {
  const directory = await mkdtemp(join(tmpdir(), "pf-lineage-migration-"))
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        for (const migration of readMigrationFiles({
          migrationsFolder: SYSTEM_MIGRATIONS_FOLDER,
        })) {
          // Exercise upgrade of an existing root, not only an empty database.
          if (
            migration.sql.some((statement) =>
              statement.includes("ADD `parent_secret_generation`"),
            )
          ) {
            yield* sql`INSERT INTO pf_org_unit (id, name, org_unit_level, path)
              VALUES ('org', 'Organisation', 'root', '/')`
            for (const id of ["root", "child", "leaf", "new"]) {
              yield* sql`INSERT INTO pf_user (id, provider, sub, last_logged_in)
                VALUES (${id}, 'google', ${id}, 1)`
              yield* sql`INSERT INTO pf_provider_user
                (id, user_id, email, name, first_name, last_name, picture, locale, org_unit_id)
                VALUES (${id}, ${id}, ${`${id}@example.com`}, ${id}, ${id}, '', '', 'en', 'org')`
              yield* sql`INSERT INTO pf_delegation
                (id, owner_provider_user, delegation_name, active_delegation_name)
                VALUES (${id}, ${id}, ${id}, ${id})`
            }
            yield* sql`INSERT INTO pf_secret_generation
              (id, delegation_id, secret_verifier, secret_issued_at, secret_expires_at)
              VALUES ('root', 'root', 'root-verifier', 1, 10)`
          }
          yield* executeMigrationStatements(migration.sql)
        }
        yield* check
      }).pipe(Effect.provide(makeMigrationLayer(join(directory, "pf.db")))),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const insertChain = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO pf_secret_generation
    (id, delegation_id, secret_verifier, secret_issued_at, secret_expires_at, parent_secret_generation)
    VALUES ('child', 'child', 'child-verifier', 2, 9, 'root')`
  yield* sql`INSERT INTO pf_secret_generation
    (id, delegation_id, secret_verifier, secret_issued_at, secret_expires_at, parent_secret_generation)
    VALUES ('leaf', 'leaf', 'leaf-verifier', 3, 8, 'child')`
})

describe("delegation migrations on real Turso Local", () => {
  it("accepts roots and children while retaining immutable, bounded ancestry", () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO pf_secret_generation
          (id, delegation_id, secret_verifier, secret_issued_at, secret_expires_at)
          VALUES ('fresh-root', 'new', 'fresh-verifier', 1, 10)`
        yield* insertChain
        expect(
          yield* sql`SELECT id, parent_secret_generation FROM pf_secret_generation ORDER BY id`,
        ).toEqual([
          { id: "child", parent_secret_generation: "root" },
          { id: "fresh-root", parent_secret_generation: null },
          { id: "leaf", parent_secret_generation: "child" },
          { id: "root", parent_secret_generation: null },
        ])
        for (const query of [
          "UPDATE pf_secret_generation SET parent_secret_generation = NULL WHERE id = 'leaf'",
          "UPDATE pf_secret_generation SET parent_secret_generation = 'leaf' WHERE id = 'root'",
          "UPDATE pf_secret_generation SET id = 'other' WHERE id = 'root'",
          "UPDATE pf_secret_generation SET delegation_id = 'new' WHERE id = 'root'",
          "DELETE FROM pf_secret_generation WHERE id = 'leaf'",
          "INSERT OR REPLACE INTO pf_secret_generation SELECT * FROM pf_secret_generation WHERE id = 'leaf'",
          "DELETE FROM pf_secret_generation_ancestor WHERE generation_id = 'leaf'",
          "UPDATE pf_secret_generation_ancestor SET ancestor_id = 'fresh-root' WHERE generation_id = 'leaf'",
        ]) {
          expect(yield* sql.unsafe(query).pipe(Effect.isFailure)).toBe(true)
        }
        for (const [delegation, parent, issued, expires] of [
          ["new", "invalid", 4, 7],
          ["new", "missing", 4, 7],
          ["new", "leaf", 4, 9],
          ["new", "leaf", 2, 7],
          ["new", "leaf", 4, 4],
          ["root", "leaf", 4, 7],
          ["child", "leaf", 4, 7],
        ] as const) {
          expect(
            yield* sql`INSERT INTO pf_secret_generation
              (id, delegation_id, secret_verifier, secret_issued_at, secret_expires_at, parent_secret_generation)
              VALUES ('invalid', ${delegation}, 'invalid-verifier', ${issued}, ${expires}, ${parent})`.pipe(
              Effect.isFailure,
            ),
          ).toBe(true)
        }
        expect(
          yield* sql`SELECT id FROM pf_secret_generation WHERE id = 'invalid'`,
        ).toEqual([])
      }),
    ))

  for (const [reason, invalidate] of [
    [
      "generation revocation",
      "UPDATE pf_secret_generation SET secret_revoked_at = 4 WHERE id = 'root'",
    ],
    [
      "generation deletion",
      "UPDATE pf_secret_generation SET _deleted = 1 WHERE id = 'root'",
    ],
    [
      "delegation revocation",
      "UPDATE pf_delegation SET secret_revoked_at = 4 WHERE id = 'root'",
    ],
    [
      "delegation deletion",
      "UPDATE pf_delegation SET _deleted = 1 WHERE id = 'root'",
    ],
    [
      "owner deletion",
      "UPDATE pf_provider_user SET _deleted = 1 WHERE id = 'root'",
    ],
    ["user deletion", "UPDATE pf_user SET _deleted = 1 WHERE id = 'root'"],
    [
      "replacement",
      "INSERT INTO pf_delegation_history (id, delegation_id, secret_generation_id, actor_provider_user, delegation_event, secret_issued_at) VALUES ('replaced', 'root', 'root', 'root', 'replaced', 4)",
    ],
    [
      "expiry",
      "UPDATE pf_secret_generation SET secret_expires_at = 4 WHERE id = 'root'",
    ],
  ] as const) {
    it(`rejects descendants after distant ancestor ${reason}, rolling back issuance`, () =>
      withDatabase(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* insertChain
          yield* sql.unsafe(invalidate)
          expect(
            yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  yield* sql`UPDATE pf_delegation SET delegation_name = 'should roll back' WHERE id = 'new'`
                  yield* sql`INSERT INTO pf_secret_generation
                  (id, delegation_id, secret_verifier, secret_issued_at, secret_expires_at, parent_secret_generation)
                  VALUES ('invalid', 'new', 'invalid-verifier', 4, 7, 'leaf')`
                }),
              )
              .pipe(Effect.isFailure),
          ).toBe(true)
          expect(
            yield* sql`SELECT delegation_name FROM pf_delegation WHERE id = 'new'`,
          ).toEqual([{ delegation_name: "new" }])
          expect(
            yield* sql`SELECT id FROM pf_secret_generation WHERE id = 'invalid'`,
          ).toEqual([])
        }),
      ))
  }
})
