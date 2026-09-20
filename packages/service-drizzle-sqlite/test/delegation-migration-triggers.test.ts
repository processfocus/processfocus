import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import { DatabaseTest } from "../src/lib/database-test"
import { describe, expect, it } from "bun:test"

describe("delegation migration triggers", () => {
  it("updates audit timestamps and preserves explicit timestamps on all delegation tables", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`PRAGMA foreign_keys = ON`
        yield* sql`
          INSERT INTO pf_org_unit (id, name, org_unit_level, path)
          VALUES ('org', 'Organisation', 'root', '/')
        `
        yield* sql`
          INSERT INTO pf_user (id, provider, sub, last_logged_in)
          VALUES ('user', 'google', 'subject', 1)
        `
        yield* sql`
          INSERT INTO pf_provider_user
            (id, user_id, email, name, first_name, last_name, picture, locale, org_unit_id)
          VALUES ('owner', 'user', 'owner@example.com', 'Owner', 'Owner', '', '', 'en', 'org')
        `
        yield* sql`
          INSERT INTO pf_delegation
            (id, owner_provider_user, delegation_name, active_delegation_name, created_at, updated_at)
          VALUES ('delegation', 'owner', 'Assistant', 'Assistant', 1, 1)
        `
        yield* sql`
          INSERT INTO pf_secret_generation
            (id, delegation_id, secret_verifier, secret_issued_at, secret_expires_at, created_at, updated_at)
          VALUES ('generation', 'delegation', 'verifier', 1, 2, 1, 1)
        `
        yield* sql`
          INSERT INTO pf_delegation_history
            (id, delegation_id, secret_generation_id, actor_provider_user, delegation_event, secret_issued_at, created_at, updated_at)
          VALUES ('history', 'delegation', 'generation', 'owner', 'created', 1, 1, 1)
        `

        for (const table of [
          "pf_delegation",
          "pf_secret_generation",
          "pf_delegation_history",
        ]) {
          expect(
            yield* sql<{ name: string }>`
              SELECT name FROM sqlite_master
              WHERE type = 'trigger' AND tbl_name = ${table}
            `,
          ).toContainEqual({ name: `${table}_updated_at_trigger` })

          yield* sql`UPDATE ${sql(table)} SET _deleted = 1`
          expect(
            yield* sql<{ advanced: number; created_at: number }>`
              SELECT updated_at > 1 AS advanced, created_at FROM ${sql(table)}
            `,
          ).toEqual([{ advanced: 1, created_at: 1 }])

          yield* sql`UPDATE ${sql(table)} SET updated_at = 2, updated_by = 'explicit'`
          expect(
            yield* sql<{
              updated_at: number
            }>`SELECT updated_at FROM ${sql(table)}`,
          ).toEqual([{ updated_at: 2 }])
        }
      }).pipe(Effect.provide(DatabaseTest)),
    ))
})
