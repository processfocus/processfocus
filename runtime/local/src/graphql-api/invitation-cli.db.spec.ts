import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { NodeFileSystem } from "@effect/platform-node"
import { DateTime, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { createSchema, createYoga } from "graphql-yoga"
import {
  OpenAuthMemoryStorageServiceLive,
  createAuthenticationServer,
} from "@pf/auth-api"
import {
  LocalCedarAuthorizationLive,
  LocalCedarConfig,
  getDefaultPoliciesPath,
  getDefaultSchemaPath,
} from "@pf/auth-local-cedar"
import * as dbSchema from "@pf/drizzle-sqlite"
import { SettingsQueries } from "@pf/graphql-db-operations"
import { createTestApp } from "@pf/openauth"
import { Organisation, OrganisationProvider } from "@pf/process"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"
import { DatabaseTest } from "@pf/service-drizzle-sqlite/test"
import {
  SqliteAuthenticationDatabaseLive,
  SqliteGraphqlDbOperationsLive,
} from "@pf/sqlite-operations"
import { transformSchemaWithAuthDirective } from "../../../../packages/graphql-api/src/lib/auth-directive-plugin"
import { createResolverExecutor } from "../../../../packages/graphql-api/src/lib/resolver-utils"
import { systemSchema } from "../../../../packages/graphql-api/src/lib/system-resolvers"
import type { UserContext } from "../../../../packages/graphql-api/src/lib/types"
import { expect, it } from "bun:test"

// This boundary owns command parsing/JSON, Cedar gates, transactional writes,
// pagination, deletion and exchange compatibility: helper tests cannot detect a broken CLI path.
// Allow for sequential CLI process startups alongside the other CI test suites.
it("manages invitations through pforg, Cedar, Yoga and SQLite and exchanges their links", async () => {
  const dir = mkdtempSync(join(tmpdir(), "invitation-cli-"))
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.mergeAll(
        SqliteGraphqlDbOperationsLive,
        SqliteAuthenticationDatabaseLive,
        LocalAuditLive.pipe(Layer.provide(SqliteAuditPersistenceLive)),
      ).pipe(Layer.provideMerge(DatabaseTest)),
      OpenAuthMemoryStorageServiceLive,
      FetchHttpClient.layer,
      NodeFileSystem.layer,
      Layer.succeed(OrganisationProvider, {
        organisation: new Organisation({ name: "Invitations" }),
        orgPath: dir,
        schemaPath: join(dir, "org.graphql"),
      }),
      LocalCedarAuthorizationLive.pipe(
        Layer.provide(
          Layer.succeed(LocalCedarConfig, {
            schemaText: readFileSync(getDefaultSchemaPath(), "utf8"),
            policiesText: [
              readFileSync(getDefaultPoliciesPath(), "utf8"),
              'permit(principal, action == PF::Action::"administerUsers", resource);',
              'forbid(principal == PF::ProviderUser::"denied@example.com", action == PF::Action::"administerUsers", resource);',
            ],
          }),
        ),
      ),
    ),
  )
  const context = (email: string): UserContext => ({
    userId: email,
    _requestTime: DateTime.nowUnsafe(),
    _userDetails: { id: email, by: email },
    jwt: {
      mode: "access",
      type: "user",
      properties: {
        userId: email,
        email,
        roles: ["/Administrator"],
        orgUnitId: "/",
        orgUnitPath: "/",
      },
      aud: "graphql-api",
      iss: "test",
      sub: email,
      exp: 0,
      iat: 0,
    },
  })
  let server: ReturnType<typeof Bun.serve> | undefined
  try {
    const setup = await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle
        const [unit] = yield* db
          .insert(dbSchema.orgUnit)
          .values({ name: "Root", orgUnitLevel: "root", path: "/" })
          .returning()
        const [role] = yield* db
          .insert(dbSchema.role)
          .values({ name: "Tester", path: "/Tester", orgUnitId: unit!.id })
          .returning()
        return { rootOrgUnitId: unit!.id, testerRoleId: role!.id }
      }),
    )
    const second = await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle
        const rows = yield* db
          .insert(dbSchema.role)
          .values({
            name: "Other",
            path: "/Other",
            orgUnitId: setup.rootOrgUnitId,
          })
          .returning()
        return rows[0]!.id
      }),
    )
    const system = await runtime.runPromise(systemSchema)
    const schema = transformSchemaWithAuthDirective(
      createSchema<UserContext>({
        typeDefs: [
          readFileSync(
            new URL(
              "../../../../packages/graphql-schema/graphql/rxdb.graphql",
              import.meta.url,
            ),
            "utf8",
          ),
          system.typeDefs,
        ],
        resolvers: system.resolvers,
      }),
      createResolverExecutor(runtime),
    )
    const yoga = createYoga({
      schema,
      context: ({ request }) =>
        context(
          request.headers.get("authorization")?.replace("Bearer ", "") ??
            "admin@example.com",
        ),
      logging: false,
    })
    server = Bun.serve({
      hostname: "localhost",
      port: 0,
      fetch: (request) => yoga.fetch(request),
    })
    writeFileSync(
      join(dir, ".graphql-port.json"),
      JSON.stringify({ port: server.port }),
    )
    const cli = async (args: string[], user = "admin@example.com") => {
      writeFileSync(
        join(dir, "credentials.json"),
        JSON.stringify({
          version: 1,
          baseUrl: "http://localhost:3000",
          accessToken: user,
          expiresAt: "2999-01-01T00:00:00Z",
          loginAt: "2026-10-27T00:00:00Z",
        }),
      )
      const child = Bun.spawn(
        [
          process.execPath,
          resolve(import.meta.dir, "../../../../cli/pforg/src/main.ts"),
          "invitation",
          ...args,
        ],
        {
          env: {
            ...process.env,
            PFORG_CREDENTIALS_PATH: join(dir, "credentials.json"),
            PF_RUNTIME_ROOT: dir,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      return { stdout, stderr, exitCode }
    }
    const output = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({
          invitation: Schema.Struct({
            id: Schema.String,
            email: Schema.String,
            roles: Schema.Array(Schema.Struct({ id: Schema.String })),
          }),
          registrationLinkUrl: Schema.NullOr(Schema.String),
          expiresAt: Schema.NullOr(Schema.String),
        }),
      ),
    )
    const success = async (args: string[]) => {
      const result = await cli(args)
      expect(result).toMatchObject({ exitCode: 0, stderr: "" })
      return output(result.stdout)
    }
    const failure = async (args: string[], message: string, user?: string) => {
      const result = await cli(args, user)
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toBe("")
      const error = Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }),
        ),
      )(result.stderr)
      expect(error.error.message).toContain(message)
    }
    const find = (email: string) =>
      runtime.runPromise(
        Effect.gen(function* () {
          return yield* (yield* SettingsQueries).queryPendingInvitationByEmail(
            email,
          )
        }),
      )
    const create = (email: string, link = false) => [
      "create",
      "--email",
      email,
      "--role",
      "/Tester",
      ...(link ? ["--registration-link"] : []),
    ]
    const list = async () => {
      const result = await cli(["list"])
      expect(result).toMatchObject({ exitCode: 0, stderr: "" })
      return Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Array(
            Schema.Struct({
              id: Schema.String,
              email: Schema.String,
              status: Schema.String,
              registrationLinkStatus: Schema.String,
              roles: Schema.Array(
                Schema.Struct({
                  id: Schema.String,
                  name: Schema.String,
                  path: Schema.String,
                }),
              ),
            }),
          ),
        ),
        { onExcessProperty: "error" },
      )(result.stdout)
    }
    expect(await list()).toEqual([])
    await failure(["list"], "Not authorized", "denied@example.com")
    await failure(["delete"], "invitation-id")
    await failure(["delete", "missing-id"], "pforg invitation list")
    await failure(["create", "--email", "missing-role@example.com"], "role")
    await failure(
      ["create", "--email", "invalid@example.com", "--role", "/Unknown"],
      "Unknown role",
    )
    await failure(create("disabled@example.com", true), "disabled")
    expect(await find("disabled@example.com")).toBeNull()
    const plain = await success([
      ...create(" Plain@Example.com "),
      "--role",
      "/Other",
    ])
    expect(plain.invitation.email).toBe("plain@example.com")
    expect(plain.invitation.roles.map((r) => r.id).sort()).toEqual(
      [setup.testerRoleId, second].sort(),
    )
    expect(plain.registrationLinkUrl).toBeNull()
    await failure(
      create("denied@example.com", true),
      "Not authorized",
      "denied@example.com",
    )
    expect(await find("denied@example.com")).toBeNull()
    await failure(create("PLAIN@example.com", true), "already exists")
    await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle
        yield* db.insert(dbSchema.oauthProvider).values({
          providerName: "passkey",
          providerConfig: {
            rpName: "Test",
            rpID: "localhost",
            origin: "http://localhost:3000",
            inviteOnly: true,
          },
        })
      }),
    )
    // A real SQL failure after creation must roll back invitation AND role rows.
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`CREATE TRIGGER fail_link BEFORE UPDATE OF registration_token_hash ON pf_invitation WHEN NEW.email = 'fail@example.com' BEGIN SELECT RAISE(ABORT, 'test issuance failure'); END`
      }),
    )
    await failure(
      create("fail@example.com", true),
      "Could not create Invitation",
    )
    expect(await find("fail@example.com")).toBeNull()
    const linked = await success(create("linked@example.com", true))
    expect(linked.registrationLinkUrl).toStartWith(
      "http://localhost:3000/register/passkey#",
    )
    expect(Date.parse(linked.expiresAt!) - Date.now()).toBeWithin(
      6.99 * 86400000,
      7.01 * 86400000,
    )
    const auth = await runtime.runPromise(
      Effect.gen(function* () {
        const { app, runtime } = yield* createAuthenticationServer({
          clients: [
            {
              id: "test-client",
              redirectUris: ["http://localhost:3000/callback"],
            },
          ],
        })
        return createTestApp(app, { runtime })
      }),
    )
    const exchange = (url: string) =>
      auth.request(
        "http://localhost/oauth/passkey/registration-session-exchange",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: new URLSearchParams(new URL(url).hash.slice(1)).get("token"),
          }),
        },
      )
    const exchanged = await exchange(linked.registrationLinkUrl!)
    expect(exchanged.status).toBe(200)
    expect(await exchanged.json()).toMatchObject({
      email: "linked@example.com",
      sessionBearer: expect.any(String),
    })
    await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle
        const sessions = yield* db.select().from(dbSchema.registrationSession)
        expect(sessions).toHaveLength(1)
        expect(sessions[0]?.invitationId).toBe(linked.invitation.id)
      }),
    )
    await failure(
      ["registration-link", "--email", "linked@example.com"],
      "--rotate",
    )
    const rotated = await success([
      "registration-link",
      "--email",
      "linked@example.com",
      "--rotate",
    ])
    expect((await exchange(linked.registrationLinkUrl!)).status).toBe(400)
    expect((await exchange(rotated.registrationLinkUrl!)).status).toBe(200)
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE pf_invitation SET registration_link_expires_at = julianday('2000-01-01') WHERE email = 'linked@example.com'`
      }),
    )
    await failure(
      ["registration-link", "--email", "linked@example.com"],
      "--rotate",
    )
    await success([
      "registration-link",
      "--email",
      "linked@example.com",
      "--rotate",
    ])
    await success(["registration-link", "--email", " PLAIN@example.com "])
    await failure(
      ["registration-link", "--email", "absent@example.com"],
      "invitation create",
    )
    await failure(create("linked@example.com", true), "already exists")
    expect((await find("plain@example.com"))?.id).toBe(plain.invitation.id)
    const mutation = `mutation($email: String!, $roles: [ID!]!) { createInvitation(input: { email: $email, roleIds: $roles }, registrationLink: true) { __typename ... on SaveInvitationFailure { error } } }`
    const direct = (
      email: string,
      roles: string[],
      user = "admin@example.com",
    ) =>
      Promise.resolve(
        yoga.fetch(
          new Request("http://localhost/graphql", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              authorization: `Bearer ${user}`,
            },
            body: JSON.stringify({
              query: mutation,
              variables: { email, roles },
            }),
          }),
        ),
      ).then((r) => r.json())
    const denied = await direct(
      "direct-denied@example.com",
      [setup.testerRoleId],
      "denied@example.com",
    )
    expect(denied.errors[0].message).toContain("Not authorized")
    expect(await find("direct-denied@example.com")).toBeNull()
    const invalid = await direct("invalid-api@example.com", ["unknown"])
    expect(invalid.data.createInvitation.error).toContain("Invalid role")
    expect(await find("invalid-api@example.com")).toBeNull()
    const concurrent = await Promise.all([
      direct("concurrent@example.com", [setup.testerRoleId]),
      direct(" CONCURRENT@example.com ", [second]),
    ])
    expect(
      concurrent.map((r) => r.data.createInvitation.__typename).sort(),
    ).toEqual(["SaveInvitationFailure", "SaveInvitationSuccess"])
    await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle
        const invitations = yield* db.select().from(dbSchema.invitation)
        const roles = yield* db.select().from(dbSchema.invitationRole)
        expect(
          invitations.filter((row) => row.email === "concurrent@example.com"),
        ).toHaveLength(1)
        expect(
          roles.every((row) =>
            invitations.some(
              (invitation) => invitation.id === row.invitationId,
            ),
          ),
        ).toBe(true)
      }),
    )
    // Revocation cannot be rotated; the Dashboard permits fresh generation.
    await runtime.runPromise(
      Effect.gen(function* () {
        const queries = yield* SettingsQueries
        yield* queries.revokeRegistrationLink(
          plain.invitation.id,
          "admin@example.com",
        )
      }),
    )
    await failure(
      ["registration-link", "--email", "plain@example.com", "--rotate"],
      "no active",
    )
    await success(["registration-link", "--email", "plain@example.com"])
    // Closed invitations remain history, never an account-recovery entry point.
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE pf_invitation SET invitation_status = 'legacy_closed', invitation_pending_email = NULL WHERE email = 'linked@example.com'`
        yield* sql`UPDATE pf_invitation SET invitation_status = 'accepted', invitation_pending_email = NULL WHERE email = 'plain@example.com'`
      }),
    )
    await failure(
      ["registration-link", "--email", "linked@example.com", "--rotate"],
      "Pending Invitation not found",
    )
    await failure(
      ["registration-link", "--email", "plain@example.com", "--rotate"],
      "Pending Invitation not found",
    )
    // Exercise real pagination (including a second status's page reset), not a
    // fake response that assumes the CLI sent the correct page/status variables.
    await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle
        for (const status of ["pending", "accepted"] as const) {
          yield* db.insert(dbSchema.invitation).values(
            Array.from({ length: 101 }, (_, index) => ({
              invitationId: `${status}-${index}`,
              email: `${status}-${index.toString().padStart(3, "0")}@example.com`,
              invitationStatus: status,
              invitationPendingEmail:
                status === "pending"
                  ? `${status}-${index.toString().padStart(3, "0")}@example.com`
                  : null,
            })),
          )
        }
      }),
    )
    const listed = await list()
    expect(listed).toHaveLength(205)
    expect(new Set(listed.map((item) => item.id)).size).toBe(205)
    expect(listed.filter((item) => item.status === "PENDING")).toHaveLength(102)
    expect(listed.filter((item) => item.status === "ACCEPTED")).toHaveLength(
      102,
    )
    expect(
      listed.find((item) => item.id === linked.invitation.id)?.status,
    ).toBe("LEGACY_CLOSED")
    expect(
      listed.find((item) => item.id === plain.invitation.id)?.roles,
    ).toEqual(
      expect.arrayContaining([
        { id: setup.testerRoleId, name: "Tester", path: "/Tester" },
        { id: second, name: "Other", path: "/Other" },
      ]),
    )
    for (const id of [plain.invitation.id, linked.invitation.id]) {
      await failure(["delete", id], "Only pending Invitations can be deleted")
    }
    const disposable = await success(create("delete-me@example.com", true))
    expect((await exchange(disposable.registrationLinkUrl!)).status).toBe(200)
    await failure(
      ["delete", disposable.invitation.id],
      "Not authorized",
      "denied@example.com",
    )
    expect(await find("delete-me@example.com")).not.toBeNull()
    const deleted = await cli(["delete", disposable.invitation.id])
    expect(deleted).toMatchObject({ exitCode: 0, stderr: "" })
    expect(JSON.parse(deleted.stdout)).toEqual({
      id: disposable.invitation.id,
      success: true,
    })
    expect(await find("delete-me@example.com")).toBeNull()
    expect((await exchange(disposable.registrationLinkUrl!)).status).toBe(400)
    await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle
        const invitations = yield* db.select().from(dbSchema.invitation)
        const deletedRow = invitations.find(
          (row) => row.id === disposable.invitation.id,
        )
        expect(deletedRow?._deleted).toBe(true)
        expect(deletedRow?.registrationTokenHash).toBeNull()
        const roles = yield* db.select().from(dbSchema.invitationRole)
        expect(
          roles
            .filter((row) => row.invitationId === disposable.invitation.id)
            .map((row) => row._deleted),
        ).toEqual([true])
      }),
    )
    expect(await list()).toEqual(listed)
    await failure(["delete", disposable.invitation.id], "pforg invitation list")
  } finally {
    server?.stop(true)
    await runtime.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
}, 120000)

import { LocalAuditLive } from "@pf/audit/local"
import { SqliteAuditPersistenceLive } from "@pf/sqlite-operations"
