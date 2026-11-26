import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Layer, Logger, ManagedRuntime, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { decodeJwt } from "jose"
import { createAuthenticationServer, redeemRoleSwitch } from "@pf/auth-api"
import {
  LocalCedarAuthorizationLive,
  LocalCedarConfig,
  getDefaultPoliciesPath,
  getDefaultSchemaPath,
  makePolicyWatcherLayer,
} from "@pf/auth-local-cedar"
import { AuthorizationService, CurrentPrincipal } from "@pf/auth-policy"
import { subjects } from "@pf/auth-session"
import * as schema from "@pf/drizzle-sqlite"
import {
  AppSchemaBuilderLive,
  AuthConfig,
  DraftProcessExecutionCollectionOpsLive,
  DynamicSchemaConfig,
  ExecutionCollectionOpsLive,
  ListExportServiceLive,
  ProcessCollectionOpsLive,
  ProcessDurationServiceLive,
  ResolverRuntime,
  SlaCalculationServiceLive,
  TodoCollectionOpsLive,
  Yoga,
  YogaLive,
} from "@pf/graphql-api"
import { UserDetails } from "@pf/graphql-db-operations"
import { createTestApp } from "@pf/openauth"
import { createClient } from "@pf/openauth/client"
import { storeOrganisation } from "@pf/org-to-db"
import { buildDynamicSchema } from "@pf/org-to-graphql-schema"
import {
  OrgUnit,
  Organisation,
  OrganisationProviderTest,
  Role,
} from "@pf/process"
import { RequestTime } from "@pf/request-time"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"
import { DatabaseTest } from "@pf/service-drizzle-sqlite/test"
import {
  SqliteAuthenticationDatabaseLive,
  SqliteDbOperationsLive,
  SqliteFileOperationsLive,
  SqliteFlowExecutionOperationsLive,
  SqliteGraphqlDbOperationsLive,
  SqliteOpenAuthStorageServiceLive,
  SqliteScheduledFlowOperationsLive,
} from "@pf/sqlite-operations"
import { SqliteQueueServiceLive } from "@pf/sqlite-queue-service"
import { TodoSummaryComputationLive } from "@pf/todo-summary"
import { DraftProcessEventsLive } from "../services/draft-process-events"
import { ExecutionEventsLive } from "../services/execution-events"
import {
  LocalDocumentStoreConfig,
  LocalDocumentStoreServiceLive,
} from "../services/local-document-store"
import { ProcessEventsLive } from "../services/process-events"
import { TodoEventsLive } from "../services/todo-events"
import { expect, setSystemTime, test } from "bun:test"

const resultSchema = Schema.decodeUnknownSync(
  Schema.Struct({
    data: Schema.optional(
      Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
    ),
    errors: Schema.optional(
      Schema.Array(Schema.Struct({ message: Schema.String })),
    ),
  }),
)
const tokenSchema = Schema.decodeUnknownSync(
  Schema.Struct({ access_token: Schema.String, refresh_token: Schema.String }),
)

async function fixture(additionalPolicy = "") {
  const dir = await mkdtemp("/tmp/opencode/role-revocation-")
  const org = new Organisation({ name: "Role revocation" })
  for (const name of ["Administrator", "Employee", "Never"])
    new Role(org, name, { name })
  const finance = new OrgUnit(org, "finance", {
    name: "Finance",
    type: "department",
  })
  new Role(finance, "Temporary", { name: "Temporary" })
  const orgLayer = OrganisationProviderTest(org, dir, join(dir, "org.graphql"))
  await writeFile(
    join(dir, "org.graphql"),
    await Effect.runPromise(
      buildDynamicSchema().pipe(Effect.provide(orgLayer)),
    ),
  )
  const defaultPolicies = await readFile(getDefaultPoliciesPath(), "utf8")
  const adminPolicy = `permit(principal is PF::ProviderUser in PF::Role::"/Administrator", action == PF::Action::"administerUsers", resource is PF::Application);`
  const temporaryPolicy = `permit(principal is PF::ProviderUser in PF::Role::"/Employee", action == PF::Action::"requestRole", resource == PF::Role::"/finance/Temporary");`
  const policyText = [
    defaultPolicies,
    adminPolicy,
    temporaryPolicy,
    additionalPolicy,
  ].join("\n")
  await writeFile(join(dir, "policies.cedar"), policyText)
  const authorization = LocalCedarAuthorizationLive.pipe(
    Layer.provide(
      Layer.succeed(LocalCedarConfig, {
        schemaText: await readFile(getDefaultSchemaPath(), "utf8"),
        policiesText: [policyText],
      }),
    ),
    Layer.provide(makePolicyWatcherLayer(dir, ["policies.cedar"])),
  )
  const persistence = Layer.mergeAll(
    LocalAuditLive.pipe(Layer.provide(SqliteAuditPersistenceLive)),
    SqliteAuthenticationDatabaseLive,
    SqliteDbOperationsLive,
    SqliteFileOperationsLive,
    SqliteFlowExecutionOperationsLive,
    SqliteScheduledFlowOperationsLive,
    SqliteGraphqlDbOperationsLive,
    SqliteOpenAuthStorageServiceLive,
  ).pipe(Layer.provideMerge(DatabaseTest))
  const base = Layer.mergeAll(
    persistence,
    authorization,
    orgLayer,
    FetchHttpClient.layer,
    Layer.succeed(RequestTime, DateTime.nowUnsafe()),
    Layer.succeed(UserDetails, { by: "SYSTEM", id: null }),
    Layer.succeed(CurrentPrincipal, null),
  )
  const documents = LocalDocumentStoreServiceLive.pipe(
    Layer.provide(
      Layer.succeed(LocalDocumentStoreConfig, {
        baseUrl: () => "http://localhost",
        storagePath: dir,
        secret: "test-only",
        maxFileSize: 1024,
      }),
    ),
  )
  const operations = Layer.mergeAll(
    DraftProcessExecutionCollectionOpsLive,
    ProcessCollectionOpsLive,
    ProcessDurationServiceLive,
    TodoCollectionOpsLive,
    ExecutionCollectionOpsLive.pipe(Layer.provide(SlaCalculationServiceLive)),
    SlaCalculationServiceLive,
    TodoSummaryComputationLive,
    ListExportServiceLive.pipe(Layer.provide(documents)),
    SqliteQueueServiceLive,
  ).pipe(Layer.provideMerge(base))
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      operations,
      documents,
      DraftProcessEventsLive,
      TodoEventsLive,
      ProcessEventsLive,
      ExecutionEventsLive,
      Layer.succeed(DynamicSchemaConfig, {
        schemaPath: join(dir, "org.graphql"),
      }),
    ),
  )
  await runtime.runPromise(storeOrganisation(org))
  const seeded = await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const roles = yield* db.select().from(schema.role)
      const admin = roles.find((role) => role.path === "/Administrator")!
      const employee = roles.find((role) => role.path === "/Employee")!
      const users: Record<string, string> = {}
      for (const email of ["owner@example.test", "other@example.test"]) {
        const [user] = yield* db
          .insert(schema.user)
          .values({
            provider: "google",
            sub: email,
            createdAt: DateTime.nowUnsafe(),
          })
          .returning()
        const [owner] = yield* db
          .insert(schema.providerUser)
          .values({
            userId: user!.id,
            email,
            name: email,
            firstName: "Test",
            lastName: "User",
            picture: "",
            locale: "en",
            orgUnitId: admin.orgUnitId,
          })
          .returning()
        users[email] = owner!.id
        yield* db.insert(schema.providerUserRole).values(
          [admin, employee].map((role) => ({
            providerUserId: owner!.id,
            roleId: role.id,
          })),
        )
      }
      return { users, admin, employee }
    }),
  )
  const makeApp = async (email: string) => {
    const secretHash = await Bun.password.hash("test-secret")
    const auth = await runtime.runPromise(
      createAuthenticationServer({
        dummyConfig: { email, sub: email },
        clients: [
          {
            id: "frontend",
            secretHash,
            tokenEndpointAuthMethod: "client_secret_basic",
            audience: "graphql-api",
            redirectUris: ["http://localhost/callback"],
          },
        ],
      }),
    )
    return createTestApp(auth.app, { runtime: auth.runtime })
  }
  let app = await makeApp("owner@example.test")
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => app.request(request.url, request),
  })
  const issuer = server.url.origin
  const client = createClient({
    issuer,
    clientID: "frontend",
    clientSecret: "test-secret",
    audience: "graphql-api",
  })
  const yoga = await runtime.runPromise(
    Yoga.pipe(
      Effect.provide(YogaLive),
      Effect.provide(AppSchemaBuilderLive),
      Effect.provideService(AuthConfig, {
        issuerUrl: issuer,
        issuerUrls: [issuer],
        jwksUri: `${issuer}/.well-known/jwks.json`,
      }),
      Effect.provideService(ResolverRuntime, runtime),
    ),
  )
  const query = async (token: string, query: string) =>
    resultSchema(
      await (
        await yoga.fetch("http://localhost/graphql", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ query }),
        })
      ).json(),
    )
  const login = async (email = "owner@example.test") => {
    app = await makeApp(email)
    const { challenge, url } = await client.authorize(
      "http://localhost/callback",
      "code",
      { pkce: true },
    )
    const start = await fetch(url, { redirect: "manual" })
    expect(start.status).toBe(302)
    const finish = await fetch(
      new URL(start.headers.get("location")!, issuer),
      {
        redirect: "manual",
        headers: { cookie: start.headers.get("set-cookie")! },
      },
    )
    const code = new URL(finish.headers.get("location")!).searchParams.get(
      "code",
    )!
    const exchanged = await client.exchange(
      code,
      "http://localhost/callback",
      challenge.verifier,
    )
    if (exchanged.err) throw exchanged.err
    const verified = await client.verify(subjects, exchanged.tokens.access)
    if (verified.err) throw verified.err
    return {
      access_token: exchanged.tokens.access,
      refresh_token: exchanged.tokens.refresh,
    }
  }
  const refresh = (token: string, scope?: string, secret = "test-secret") =>
    fetch(`${issuer}/oauth/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`frontend:${secret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token,
        ...(scope ? { scope } : {}),
      }),
    })
  const prepare = async (token: string, role: string) =>
    query(
      token,
      `mutation { requestRole(rolePath: ${JSON.stringify(role)}) { success error } }`,
    )
  const switchRole = async (
    tokens: Awaited<ReturnType<typeof login>>,
    role: string,
  ) => {
    expect((await prepare(tokens.access_token, role)).data).toEqual({
      requestRole: { success: true, error: null },
    })
    const response = await refresh(
      tokens.refresh_token,
      `role:${encodeURIComponent(role)}`,
    )
    expect(response.status).toBe(200)
    return tokenSchema(await response.json())
  }
  const removeAdmin = (token: string) =>
    query(
      token,
      `mutation { updateProviderUser(providerUserId: ${JSON.stringify(seeded.users["owner@example.test"])}, input: { roleIds: [${JSON.stringify(seeded.employee.id)}] }) { __typename } }`,
    )
  const updatePolicy = async (policies: string) => {
    const version = () =>
      runtime.runPromise(
        Effect.gen(function* () {
          return yield* (yield* AuthorizationService).policyVersion
        }),
      )
    const previous = await version()
    await writeFile(join(dir, "policies.cedar"), policies)
    const deadline = Date.now() + 5000
    while ((await version()) === previous) {
      if (Date.now() >= deadline)
        throw new Error("Cedar watcher did not reload")
      await Bun.sleep(20)
    }
  }
  return {
    runtime,
    seeded,
    query,
    login,
    refresh,
    prepare,
    switchRole,
    removeAdmin,
    withdrawPolicy: () =>
      updatePolicy([defaultPolicies, adminPolicy].join("\n")),
    close: async () => {
      server.stop(true)
      await runtime.dispose()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test("time-dependent role permission is rechecked at protected use after mechanical redemption and renewal", async () => {
  const f = await fixture(
    `forbid(principal, action == PF::Action::"requestRole", resource == PF::Role::"/Administrator") when { context.requestTime.toTime() >= duration("12h") };`,
  )
  try {
    // Cedar evaluates local wall time. Cross noon without waiting on the runner.
    const noon = new Date()
    noon.setHours(12, 0, 0, 0)
    setSystemTime(noon.getTime() - 1000)
    const tokens = await f.switchRole(await f.login(), "/Employee")
    expect(
      (await f.prepare(tokens.access_token, "/Administrator")).data,
    ).toMatchObject({ requestRole: { success: true } })
    setSystemTime(noon)
    expect(
      (await f.prepare(tokens.access_token, "/Administrator")).data,
    ).toMatchObject({ requestRole: { success: false } })
    const response = await f.refresh(
      tokens.refresh_token,
      "role:%2FAdministrator",
    )
    expect(response.status).toBe(200)
    const switched = tokenSchema(await response.json())
    for (const scope of [undefined, "cli"]) {
      const renewal = await f.refresh(switched.refresh_token, scope)
      expect(renewal.status).toBe(200)
      const renewed = tokenSchema(await renewal.json())
      expect(
        (
          await f.query(
            renewed.access_token,
            "{ allUsers(limit: 1) { totalCount } }",
          )
        ).errors?.length,
      ).toBeGreaterThan(0)
    }
    expect(
      (
        await f.query(
          switched.access_token,
          "{ allUsers(limit: 1) { totalCount } }",
        )
      ).errors?.length,
    ).toBeGreaterThan(0)
  } finally {
    setSystemTime()
    await f.close()
  }
}, 60_000)

test("role preparation diagnostics distinguish stale authority from an unavailable receipt", async () => {
  const f = await fixture()
  try {
    const tokens = await f.login()
    const session = Schema.decodeUnknownSync(subjects.providerUser)(
      decodeJwt(tokens.access_token)["properties"],
    )
    expect(
      (await f.prepare(tokens.access_token, "/Employee")).data,
    ).toMatchObject({
      requestRole: { success: true },
    })
    await f.withdrawPolicy()
    const messages: unknown[] = []
    const logger = Logger.make(({ message }) => messages.push(message))
    const denial = () =>
      f.runtime.runPromise(
        redeemRoleSwitch(session, "/Employee").pipe(
          Effect.flip,
          Effect.provide(Logger.layer([logger])),
        ),
      )
    expect(await denial()).toMatchObject({
      _tag: "InvalidRolePreparation",
      reason: "version-mismatch",
      message: "Invalid role preparation: version-mismatch",
    })
    // Failed validation still consumes the receipt; diagnostics must not imply a known replay.
    expect(await denial()).toMatchObject({
      _tag: "InvalidRolePreparation",
      reason: "missing-expired-or-consumed",
    })
    const logContext = {
      userId: session.userId,
      orgUnitId: session.orgUnitId,
      orgUnitPath: session.orgUnitPath,
      role: "/Employee",
    }
    expect(messages).toEqual([
      [
        "Role switch redemption denied",
        { ...logContext, reason: "version-mismatch" },
      ],
      [
        "Role switch redemption denied",
        { ...logContext, reason: "missing-expired-or-consumed" },
      ],
    ])
  } finally {
    await f.close()
  }
}, 30_000)

test("role removal at the real mutation revokes existing access and ordinary, scoped and CLI renewal", async () => {
  const f = await fixture()
  try {
    let tokens = await f.login()
    tokens = await f.switchRole(tokens, "/Employee")
    expect(
      (
        await f.query(
          tokens.access_token,
          "{ allUsers(limit: 1) { totalCount } }",
        )
      ).errors?.length,
    ).toBeGreaterThan(0)
    tokens = await f.switchRole(tokens, "/Administrator")
    const ordinary = await f.refresh(tokens.refresh_token)
    expect(ordinary.status).toBe(200)
    tokens = tokenSchema(await ordinary.json())
    expect(decodeJwt(tokens.access_token)["properties"]).toMatchObject({
      roles: ["/Administrator"],
    })
    expect(
      (
        await f.query(
          tokens.access_token,
          "{ allUsers(limit: 1) { totalCount } }",
        )
      ).errors,
    ).toBeUndefined()
    expect((await f.removeAdmin(tokens.access_token)).data).toEqual({
      updateProviderUser: { __typename: "UpdateProviderUserSuccess" },
    })
    const protectedResult = await f.query(
      tokens.access_token,
      "{ allUsers(limit: 1) { totalCount } }",
    )
    const renewalStatuses = []
    for (const scope of [undefined, "role:%2FAdministrator", "cli"])
      renewalStatuses.push(
        (await f.refresh(tokens.refresh_token, scope)).status,
      )
    expect({
      protectedDenied: (protectedResult.errors?.length ?? 0) > 0,
      renewalStatuses,
    }).toEqual({ protectedDenied: true, renewalStatuses: [400, 400, 400] })
    const fresh = await f.login()
    expect(
      (await f.prepare(fresh.access_token, "/Administrator")).data,
    ).toMatchObject({ requestRole: { success: false } })
    expect(
      (await f.refresh(fresh.refresh_token, "role:%2FAdministrator")).status,
    ).toBe(400)
  } finally {
    await f.close()
  }
}, 30_000)

test("assignment replacement and Cedar withdrawal invalidate preparations and separate temporary authority", async () => {
  const f = await fixture()
  try {
    const first = await f.login()
    const other = await f.login("other@example.test")
    await f.prepare(first.access_token, "/Employee")
    // Even replacing identical assignments invalidates the old preparation identities.
    expect(
      (
        await f.query(
          other.access_token,
          `mutation { updateProviderUser(providerUserId: ${JSON.stringify(f.seeded.users["owner@example.test"])}, input: { roleIds: [${JSON.stringify(f.seeded.admin.id)}, ${JSON.stringify(f.seeded.employee.id)}] }) { __typename } }`,
        )
      ).errors,
    ).toBeUndefined()
    expect(
      (await f.refresh(first.refresh_token, "role:%2FEmployee")).status,
    ).toBe(400)
    const fresh = await f.login()
    const temporary = await f.switchRole(fresh, "/finance/Temporary")
    expect(decodeJwt(temporary.access_token)["properties"]).toMatchObject({
      roles: ["/finance/Temporary"],
      orgUnitPath: "/finance",
    })
    expect((await f.refresh(temporary.refresh_token)).status).toBe(200)
    expect(
      (await f.query(temporary.access_token, "{ __typename }")).errors,
    ).toBeUndefined()
    const restored = await f.switchRole(temporary, "/Employee")
    expect(decodeJwt(restored.access_token)["properties"]).toMatchObject({
      roles: ["/Employee"],
      orgUnitPath: "/",
    })
    await f.prepare(other.access_token, "/finance/Temporary")
    await f.withdrawPolicy()
    expect(
      (await f.refresh(other.refresh_token, "role:%2Ffinance%2FTemporary"))
        .status,
    ).toBe(400)
    expect((await f.refresh(temporary.refresh_token)).status).toBe(400)
    expect(
      (await f.query(temporary.access_token, "{ __typename }")).errors?.length,
    ).toBeGreaterThan(0)
    expect(
      (await f.prepare(other.access_token, "/finance/Temporary")).data,
    ).toMatchObject({ requestRole: { success: false } })
  } finally {
    await f.close()
  }
}, 30_000)

test("preparations are session/user/role bound, expiring, single-use under concurrent redemption, and require client authentication", async () => {
  const f = await fixture()
  try {
    const first = await f.login()
    const second = await f.login()
    const other = await f.login("other@example.test")
    expect((await f.prepare(first.access_token, "/Never")).data).toMatchObject({
      requestRole: { success: false },
    })
    expect(
      (await f.prepare(first.access_token, "/Employee")).data,
    ).toMatchObject({ requestRole: { success: true } })
    for (const tokens of [second, other])
      expect(
        (await f.refresh(tokens.refresh_token, "role:%2FEmployee")).status,
      ).toBe(400)
    expect(
      (await f.refresh(first.refresh_token, "role:%2FEmployee", "wrong"))
        .status,
    ).toBe(401)
    const results = await Promise.all([
      f.refresh(first.refresh_token, "role:%2FEmployee"),
      f.refresh(first.refresh_token, "role:%2FEmployee"),
    ])
    expect(results.map((result) => result.status).sort()).toEqual([200, 400])
    expect(
      (await f.refresh(first.refresh_token, "role:%2FEmployee")).status,
    ).toBe(400)
    const fresh = await f.login()
    await f.prepare(fresh.access_token, "/Administrator")
    await f.runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle
        yield* db
          .update(schema.oauthStorage)
          .set({ keyExpiry: DateTime.makeUnsafe("2025-01-01T00:00:00Z") })
          .where(eq(schema.oauthStorage.keyKind, "role-switch"))
        yield* db.insert(schema.permittedRole).values({
          providerUserId: f.seeded.users["owner@example.test"]!,
          roleId: f.seeded.admin.id,
        })
      }),
    )
    expect(
      (await f.refresh(fresh.refresh_token, "role:%2FAdministrator")).status,
    ).toBe(400)
    expect((await f.removeAdmin(other.access_token)).errors).toBeUndefined()
    const after = await f.login()
    expect(
      (await f.refresh(after.refresh_token, "role:%2FAdministrator")).status,
    ).toBe(400)
    const parts = after.access_token.split(".")
    parts[1] = Buffer.from(
      JSON.stringify({
        ...decodeJwt(after.access_token),
        properties: {
          ...Schema.decodeUnknownSync(
            Schema.Record(Schema.String, Schema.Unknown),
          )(decodeJwt(after.access_token)["properties"]),
          roles: ["/Administrator"],
        },
      }),
    ).toString("base64url")
    expect(
      (await f.query(parts.join("."), "{ allUsers(limit: 1) { totalCount } }"))
        .errors?.length,
    ).toBeGreaterThan(0)
  } finally {
    await f.close()
  }
}, 30_000)

import { LocalAuditLive } from "@pf/audit/local"
import { SqliteAuditPersistenceLive } from "@pf/sqlite-operations"
