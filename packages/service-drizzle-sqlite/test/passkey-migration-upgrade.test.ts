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

describe("#2215 passkey migration upgrade", () => {
  it("removes only legacy passkey state and installs the final credential schema", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqliteClient.SqliteClient
        const migrations = readMigrationFiles({ migrationsFolder })
        const createCredentialMigration = migrations.at(-2)
        const finalizeCredentialMigration = migrations.at(-1)

        expect(createCredentialMigration?.name).toBe(
          "20260727044204_nostalgic_lightspeed",
        )
        expect(finalizeCredentialMigration?.name).toBe(
          "20260727044743_green_thaddeus_ross",
        )
        if (!createCredentialMigration || !finalizeCredentialMigration) {
          throw new Error("Expected both #2215 SQLite migrations")
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

        for (const migration of migrations.slice(0, -2)) {
          yield* applyMigration(migration)
        }

        yield* sql`
          INSERT INTO pf_org_unit
            (id, name, org_unit_level, path)
          VALUES
            ('org', 'Organisation', 'root', '/')
        `
        yield* sql`
          INSERT INTO pf_role
            (id, org_unit_id, name, path)
          VALUES
            ('role', 'org', 'Member', '/member')
        `
        yield* sql`
          INSERT INTO pf_user
            (id, provider, sub, last_logged_in)
          VALUES
            ('passkey-user', 'passkey', 'legacy-handle', 1),
            ('oauth-user', 'google', 'google-subject', 2)
        `
        yield* sql`
          INSERT INTO pf_provider_user
            (id, user_id, email, name, first_name, last_name, picture, locale, org_unit_id)
          VALUES
            ('passkey-provider-user', 'passkey-user', 'passkey@example.com', 'Passkey User', 'Passkey', 'User', '', 'en', 'org'),
            ('oauth-provider-user', 'oauth-user', 'oauth@example.com', 'OAuth User', 'OAuth', 'User', '', 'en', 'org')
        `
        yield* sql`
          INSERT INTO pf_user_settings
            (id, user_id, notification_preference)
          VALUES
            ('passkey-settings', 'passkey-user', '{}'),
            ('oauth-settings', 'oauth-user', '{}')
        `
        yield* sql`
          INSERT INTO pf_provider_user_role
            (id, provider_user_id, role_id)
          VALUES
            ('passkey-provider-role', 'passkey-provider-user', 'role'),
            ('oauth-provider-role', 'oauth-provider-user', 'role')
        `
        yield* sql`
          INSERT INTO pf_permitted_role
            (id, provider_user_id, role_id)
          VALUES
            ('passkey-permitted-role', 'passkey-provider-user', 'role'),
            ('oauth-permitted-role', 'oauth-provider-user', 'role')
        `
        yield* sql`
          INSERT INTO pf_oauth_storage
            (id, oauth_key, key_kind, key_value, _deleted)
          VALUES
            ('passkey-storage-1', 'passkey:one', 'passkey', '{"credential":"one"}', 0),
            ('passkey-storage-2', 'passkey:two', 'passkey', '{"credential":"two"}', 1),
            ('oauth-storage', 'oauth:authorization', 'authorization', '{"code":"kept"}', 0)
        `

        yield* applyMigration(createCredentialMigration)

        expect(
          yield* sql<{ count: number }>`
          SELECT count(*) AS count FROM pf_oauth_storage WHERE key_kind = 'passkey'
        `,
        ).toEqual([{ count: 0 }])
        expect(
          yield* sql<{
            oauth_key: string
            key_kind: string
            key_value: string
            _deleted: number
          }>`
          SELECT oauth_key, key_kind, key_value, _deleted
          FROM pf_oauth_storage
          WHERE id = 'oauth-storage'
        `,
        ).toEqual([
          {
            oauth_key: "oauth:authorization",
            key_kind: "authorization",
            key_value: '{"code":"kept"}',
            _deleted: 0,
          },
        ])

        for (const table of [
          "pf_user",
          "pf_provider_user",
          "pf_user_settings",
          "pf_provider_user_role",
          "pf_permitted_role",
        ]) {
          expect(
            yield* sql<{ _deleted: number }>(
              rawSql(`
            SELECT _deleted FROM ${table}
            WHERE id LIKE 'passkey-%'
          `),
            ),
          ).toEqual([{ _deleted: 1 }])
          expect(
            yield* sql<{ _deleted: number }>(
              rawSql(`
            SELECT _deleted FROM ${table}
            WHERE id LIKE 'oauth-%'
          `),
            ),
          ).toEqual([{ _deleted: 0 }])
        }

        yield* sql`
          INSERT INTO pf_user
            (id, provider, sub, last_logged_in)
          VALUES
            ('new-passkey-user', 'passkey', 'new-random-handle', 3)
        `
        yield* sql`
          INSERT INTO pf_provider_user
            (id, user_id, email, name, first_name, last_name, picture, locale, org_unit_id)
          VALUES
            ('new-passkey-provider-user', 'new-passkey-user', 'new-passkey@example.com', 'New Passkey User', 'New', 'User', '', 'en', 'org')
        `
        yield* sql`
          INSERT INTO pf_passkey_credential
            (id, user_id, passkey_credential_id, passkey_public_key, signature_counter)
          VALUES
            ('migrated-credential', 'new-passkey-user', 'credential-before-finalization', 'public-key', 7)
        `

        yield* applyMigration(finalizeCredentialMigration)

        expect(
          yield* sql<{ type: string }>`
          SELECT type
          FROM pragma_table_info('pf_passkey_credential')
          WHERE name = 'signature_counter'
        `,
        ).toEqual([{ type: "text(16)" }])
        expect(
          yield* sql<{ signature_counter: string; storage_type: string }>`
          SELECT signature_counter, typeof(signature_counter) AS storage_type
          FROM pf_passkey_credential
          WHERE id = 'migrated-credential'
        `,
        ).toEqual([{ signature_counter: "7", storage_type: "text" }])

        yield* sql`
          INSERT INTO pf_passkey_credential
            (id, user_id, passkey_credential_id, passkey_public_key, signature_counter, updated_at)
          VALUES
            ('final-credential', 'new-passkey-user', 'credential-after-finalization', 'public-key', '18446744073709551615', 1)
        `
        yield* sql`
          UPDATE pf_passkey_credential
          SET signature_counter = '18446744073709551614'
          WHERE id = 'final-credential'
        `

        expect(
          yield* sql<{
            signature_counter: string
            storage_type: string
            updated_at: number
          }>`
          SELECT signature_counter, typeof(signature_counter) AS storage_type, updated_at
          FROM pf_passkey_credential
          WHERE id = 'final-credential'
        `,
        ).toEqual([
          {
            signature_counter: "18446744073709551614",
            storage_type: "text",
            updated_at: expect.any(Number),
          },
        ])
        const [{ updated_at: triggeredUpdatedAt }] = yield* sql<{
          updated_at: number
        }>`
          SELECT updated_at FROM pf_passkey_credential
          WHERE id = 'final-credential'
        `
        expect(triggeredUpdatedAt).toBeGreaterThan(1)
      }).pipe(
        Effect.provide(
          SqliteClient.layer({
            filename: ":memory:",
          }),
        ),
      ),
    ))
})
