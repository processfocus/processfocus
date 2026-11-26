import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { makeDatabaseConfigLayer } from "@pf/db-info"
import { SettingsQueries } from "@pf/graphql-db-operations"
import { TypedSqliteDrizzleLayer } from "@pf/service-drizzle-sqlite"
import { SqliteSettingsQueriesLive } from "@pf/sqlite-operations"
import { makePfcliSqlClientLayer } from "../src/utils/local-database-layer"
import {
  copySharedImportedDemoDatabase,
  runPfcliInProcess,
  useSerializedTestState,
  withEnv,
} from "./test-helpers"
import { afterAll, beforeEach, describe, expect, it } from "bun:test"

useSerializedTestState()
mkdirSync("/tmp/opencode", { recursive: true })
const root = mkdtempSync("/tmp/opencode/pfcli-invitation-create-")
let orgPath = ""
let databasePath = ""
let sequence = 0
const env = {
  SQLITE_DATABASE_PATH: undefined,
  PF_ORG: undefined,
  NODE_ENV: "test",
}
const layer = () =>
  SqliteSettingsQueriesLive.pipe(
    Layer.provideMerge(TypedSqliteDrizzleLayer),
    Layer.provideMerge(makePfcliSqlClientLayer(databasePath)),
    Layer.provide(makeDatabaseConfigLayer(databasePath)),
  )
const create = (email: string, roles: readonly string[]) =>
  withEnv(env, () =>
    runPfcliInProcess([
      "invitation",
      "create",
      orgPath,
      "--email",
      email,
      ...roles.flatMap((role) => ["--role", role]),
    ]),
  )
const readInvitation = (email: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const settings = yield* SettingsQueries
      return yield* settings.queryInvitationByNormalizedEmail(email)
    }).pipe(Effect.provide(layer())),
  )
const rolePaths = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const settings = yield* SettingsQueries
      return (yield* settings.queryAllRoles())
        .slice(0, 2)
        .map((role) => role.path)
    }).pipe(Effect.provide(layer())),
  )

afterAll(() => rmSync(root, { recursive: true, force: true }))
beforeEach(async () => {
  process.exitCode = 0
  orgPath = join(root, String(++sequence))
  databasePath = join(orgPath, "db", "pf.db")
  await copySharedImportedDemoDatabase(databasePath)
})

describe("pfcli invitation create", () => {
  it("persists normalized pending grants with multiple roles and supports Registration Links", async () => {
    const paths = await rolePaths()
    expect(paths).toHaveLength(2)
    const result = await create("  Bootstrap@Example.COM  ", [
      ...paths,
      paths[0]!,
    ])
    expect(result.status).toBe(0)
    expect(result.output).toContain(
      "Created pending Invitation for bootstrap@example.com",
    )
    expect(result.output).not.toContain("token=")
    const invitation = await readInvitation("bootstrap@example.com")
    expect(invitation).toMatchObject({
      email: "bootstrap@example.com",
      status: "pending",
      source: "cli",
    })
    expect(invitation?.roles.map((role) => role.path).sort()).toEqual(
      [...paths].sort(),
    )
    const audit = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql`SELECT created_by, updated_by, registration_token_hash
        FROM pf_invitation WHERE email = 'bootstrap@example.com'`
      }).pipe(Effect.provide(layer())),
    )
    expect(audit).toEqual([
      {
        created_by: "SYSTEM",
        updated_by: "SYSTEM",
        registration_token_hash: null,
      },
    ])
    const link = await withEnv(
      { ...env, FRONTEND_BASE_URL: "http://localhost:3000" },
      () =>
        runPfcliInProcess([
          "invitation",
          "registration-link",
          orgPath,
          "--email",
          "bootstrap@example.com",
        ]),
    )
    expect(link.status).toBe(0)
    expect(link.output).toContain(
      "http://localhost:3000/register/passkey#token=",
    )
  }, 120_000)

  it("rejects normalized duplicates and invalid inputs without changing persisted grants", async () => {
    const paths = await rolePaths()
    expect((await create("duplicate@example.com", paths)).status).toBe(0)
    const before = await readInvitation("duplicate@example.com")
    const duplicate = await create(" Duplicate@Example.COM ", [paths[0]!])
    expect(duplicate.status).toBe(1)
    expect(duplicate.output).toContain("pending invitation already exists")
    expect(await readInvitation("duplicate@example.com")).toEqual(before)
    for (const [email, roles, message] of [
      [
        "unknown@example.com",
        [paths[0]!, "/missing-role"],
        "Unknown role path",
      ],
      ["not-an-email", paths, "valid email address"],
      ["missing-role@example.com", [], "role"],
    ] satisfies [string, string[], string][]) {
      const result = await create(email, roles)
      expect(result.status).toBe(1)
      expect(result.output).toContain(message)
      expect(await readInvitation(email)).toBeNull()
    }
  }, 120_000)

  it("rolls back the invitation when role persistence fails", async () => {
    const paths = await rolePaths()
    // A real database constraint forces the failure after the invitation insert.
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`DELETE FROM pf_invitation_role`
        yield* sql`CREATE UNIQUE INDEX test_one_grant_per_role ON pf_invitation_role(role_id)`
      }).pipe(Effect.provide(layer())),
    )
    expect((await create("first@example.com", paths)).status).toBe(0)
    const before = await readInvitation("first@example.com")
    const result = await create("rollback@example.com", paths)
    expect(result.status).toBe(1)
    expect(result.output).toContain("Could not create Invitation")
    expect(await readInvitation("rollback@example.com")).toBeNull()
    expect(await readInvitation("first@example.com")).toEqual(before)
    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql`SELECT count(*) AS count FROM pf_invitation_role`
      }).pipe(Effect.provide(layer())),
    )
    expect(rows[0]?.["count"]).toBe(paths.length)
  }, 120_000)

  it("uses SQLITE_DATABASE_PATH and PF_ORG, and rejects remote database URLs", async () => {
    const paths = await rolePaths()
    for (const [configuration, email] of [
      [
        { SQLITE_DATABASE_PATH: databasePath, PF_ORG: "/nonexistent" },
        "path@example.com",
      ],
      [{ SQLITE_DATABASE_PATH: undefined, PF_ORG: orgPath }, "org@example.com"],
    ] satisfies [Record<string, string | undefined>, string][]) {
      const result = await withEnv(configuration, () =>
        runPfcliInProcess([
          "invitation",
          "create",
          "--email",
          email,
          "--role",
          paths[0]!,
        ]),
      )
      expect(result.status).toBe(0)
      expect(await readInvitation(email)).not.toBeNull()
    }
    const result = await withEnv(
      { SQLITE_DATABASE_PATH: "https://example.invalid" },
      () =>
        runPfcliInProcess([
          "invitation",
          "create",
          orgPath,
          "--email",
          "remote@example.com",
          "--role",
          paths[0]!,
        ]),
    )
    expect(result.status).toBe(1)
    expect(result.output).toContain("requires a local database file")
  }, 120_000)
})
