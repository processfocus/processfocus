import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { readMigrationFiles } from "drizzle-orm/migrator"
import { Effect } from "effect"
import { describe, expect, it } from "bun:test"

const migrationsFolder = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../drizzle-sqlite/drizzle",
)
const rawSql = (query: string) => Object.assign([query], { raw: [query] })

describe("#2216 invitation lifecycle migration upgrade", () => {
  it("marks matching OAuth invitations legacy-closed and leaves unmatched pending", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqliteClient.SqliteClient
        const migrations = readMigrationFiles({ migrationsFolder })
        const invitationLifecycleMigration = migrations.at(-1)

        expect(invitationLifecycleMigration?.name).toBe(
          "20260727085203_safe_flatman",
        )
        if (!invitationLifecycleMigration) {
          throw new Error(
            "Expected #2216 SQLite invitation lifecycle migration",
          )
        }

        yield* sql`PRAGMA foreign_keys = ON`
        yield* sql`
          CREATE TABLE __drizzle_migrations (
            id INTEGER PRIMARY KEY,
            hash text NOT NULL,
            created_at numeric,
            name text,
            applied_at TEXT
          )
        `

        const applyMigration = (migration: (typeof migrations)[number]) =>
          Effect.gen(function* () {
            for (const query of migration.sql) {
              if (query.trim().length > 0) yield* sql(rawSql(query))
            }
            yield* sql`
              INSERT INTO __drizzle_migrations
                (hash, created_at, name, applied_at)
              VALUES
                (${migration.hash}, ${migration.folderMillis}, ${migration.name}, 'test')
            `
          })

        for (const migration of migrations.slice(0, -1)) {
          yield* applyMigration(migration)
        }

        yield* sql`
          INSERT INTO pf_org_unit
            (id, name, org_unit_level, path)
          VALUES
            ('org', 'Organisation', 'root', '/')
        `
        yield* sql`
          INSERT INTO pf_user
            (id, provider, sub, last_logged_in)
          VALUES
            ('oauth-user', 'google', 'google-subject', 2)
        `
        yield* sql`
          INSERT INTO pf_provider_user
            (id, user_id, email, name, first_name, last_name, picture, locale, org_unit_id)
          VALUES
            ('oauth-provider-user', 'oauth-user', 'OAuth@Example.com', 'OAuth User', 'OAuth', 'User', '', 'en', 'org')
        `
        yield* sql`
          INSERT INTO pf_invitation
            (id, invitation_id, email, created_at)
          VALUES
            ('inv-matched', 'matched-invite', '  OAuth@Example.com  ', 1),
            ('inv-unmatched', 'unmatched-invite', 'pending@example.com', 2),
            ('inv-dup-old', 'dup-invite-old', 'Dup@Example.com', 3),
            ('inv-dup-new', 'dup-invite-new', 'dup@example.com', 4)
        `

        yield* applyMigration(invitationLifecycleMigration)

        const matched = yield* sql`
          SELECT
            invitation_status,
            invitation_source,
            invitation_pending_email,
            email,
            accepted_by_provider_user,
            invitation_accepted_at,
            invitation_legacy_closure_reason
          FROM pf_invitation
          WHERE id = 'inv-matched'
        `
        const unmatched = yield* sql`
          SELECT
            invitation_status,
            invitation_source,
            invitation_pending_email,
            email,
            accepted_by_provider_user,
            invitation_accepted_at,
            invitation_legacy_closure_reason
          FROM pf_invitation
          WHERE id = 'inv-unmatched'
        `
        const dupOld = yield* sql`
          SELECT
            invitation_status,
            invitation_pending_email,
            _deleted
          FROM pf_invitation
          WHERE id = 'inv-dup-old'
        `
        const dupNew = yield* sql`
          SELECT
            invitation_status,
            invitation_pending_email,
            _deleted
          FROM pf_invitation
          WHERE id = 'inv-dup-new'
        `

        expect(matched[0]).toMatchObject({
          invitation_status: "legacy_closed",
          invitation_source: "legacy",
          invitation_pending_email: null,
          email: "oauth@example.com",
          accepted_by_provider_user: "oauth-provider-user",
          invitation_accepted_at: null,
          invitation_legacy_closure_reason: "existing_provider_user",
        })
        expect(unmatched[0]).toMatchObject({
          invitation_status: "pending",
          invitation_source: "legacy",
          invitation_pending_email: "pending@example.com",
          email: "pending@example.com",
          accepted_by_provider_user: null,
          invitation_accepted_at: null,
          invitation_legacy_closure_reason: null,
        })
        // Oldest case-variant pending row is kept; newer duplicate is soft-deleted.
        expect(dupOld[0]).toMatchObject({
          invitation_status: "pending",
          invitation_pending_email: "dup@example.com",
          _deleted: 0,
        })
        expect(dupNew[0]).toMatchObject({
          invitation_pending_email: null,
          _deleted: 1,
        })
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
    ))
})
