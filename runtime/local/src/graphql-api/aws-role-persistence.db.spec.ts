import { eq } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import { AuthenticationConfig, AwsRoleBindingSchema } from "@pf/auth-config"
import { encodeWorkloadAudit } from "@pf/auth-session"
import * as postgresSchema from "@pf/drizzle-postgres"
import {
  AwsRoleProofStore,
  ProcessExecutionOperations,
  UserDetails,
} from "@pf/graphql-db-operations"
import { type DbOperations, storeOrganisation } from "@pf/org-to-db"
import {
  PostgresDbOperationsLive,
  PostgresGraphqlDbOperationsLive,
} from "@pf/postgres-operations"
import { Organisation } from "@pf/process"
import { RequestTime } from "@pf/request-time"
import { TypedPostgresDrizzle } from "@pf/service-drizzle-postgres"
import { PostgresTest } from "@pf/service-drizzle-postgres/test"
import { DatabaseTest } from "@pf/service-drizzle-sqlite/test"
import {
  SqliteDbOperationsLive,
  SqliteGraphqlDbOperationsLive,
} from "@pf/sqlite-operations"
import { expect, it } from "bun:test"

const databases: readonly {
  name: string
  layer: Layer.Layer<
    AwsRoleProofStore | DbOperations | SqlClient.SqlClient,
    unknown
  >
}[] = [
  {
    name: "SQLite",
    layer: Layer.mergeAll(
      SqliteDbOperationsLive,
      SqliteGraphqlDbOperationsLive,
    ).pipe(Layer.provideMerge(DatabaseTest)),
  },
  {
    name: "Postgres",
    layer: Layer.mergeAll(
      PostgresDbOperationsLive,
      PostgresGraphqlDbOperationsLive,
    ).pipe(Layer.provideMerge(PostgresTest)),
  },
]

it("Postgres: starts an execution retaining full AWS attribution for maximum-length configured IDs", async () => {
  const binding = Schema.decodeUnknownSync(AwsRoleBindingSchema)({
    id: "b".repeat(256),
    serviceAccountId: "a".repeat(128),
    targetIssuer: "https://auth.dev.example",
    accountId: "123456789012",
    roleId: "AROA12345678901234567",
  })
  if (binding.roleId === undefined) throw new Error("Expected a pinned role")
  const awsRole = {
    provider: "aws" as const,
    accountId: binding.accountId,
    roleId: binding.roleId,
    bindingId: binding.id,
    requestId: "12345678-1234-1234-1234-123456789012",
    expiresAt: 1794800000,
  }
  const by = encodeWorkloadAudit({
    userId: binding.serviceAccountId,
    clientId: binding.serviceAccountId,
    awsRole,
  })
  if (!by) throw new Error("Missing AWS audit attribution")
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* TypedPostgresDrizzle
      const operations = yield* ProcessExecutionOperations
      yield* db.insert(postgresSchema.orgUnit).values({
        id: "aws-audit-org",
        name: "AWS audit",
        orgUnitLevel: "organisation",
        path: "/",
      })
      yield* db.insert(postgresSchema.process).values({
        id: "aws-audit-process",
        orgUnitId: "aws-audit-org",
        name: "AWS audit",
        path: "/audit",
        purpose: "Audit regression",
      })
      yield* db.insert(postgresSchema.step).values({
        id: "aws-audit-step",
        processId: "aws-audit-process",
        name: "Start",
        path: "/audit/start",
        purpose: "Start",
      })
      const state = yield* operations.insertProcessState(
        "aws-audit-process",
        "/audit/start",
        {},
      )
      const executionId = yield* operations.insertProcessExecution(
        state.processStateId,
      )
      const [storedState] = yield* db
        .select()
        .from(postgresSchema.processState)
        .where(eq(postgresSchema.processState.id, state.processStateId))
      const [storedExecution] = yield* db
        .select()
        .from(postgresSchema.processExecution)
        .where(eq(postgresSchema.processExecution.id, executionId))
      for (const row of [storedState, storedExecution]) {
        expect(row?.createdBy).toBe(by)
        expect(row?.updatedBy).toBe(by)
        expect(JSON.parse(row!.createdBy.slice("pf:aws-role:".length))).toEqual(
          { actor: binding.serviceAccountId, ...awsRole },
        )
      }
    }).pipe(
      Effect.provideService(UserDetails, { by, id: null }),
      Effect.provideService(RequestTime, DateTime.nowUnsafe()),
      Effect.provide(
        PostgresGraphqlDbOperationsLive.pipe(Layer.provideMerge(PostgresTest)),
      ),
    ),
  )
}, 120000)

for (const database of databases) {
  it(`${database.name}: imports AWS trust independently of secrets and atomically retains replay admission`, async () => {
    const common = {
      targetIssuer: "https://auth.dev.example",
      accountId: "123456789012",
      serviceAccountId: "orders",
    }
    const bindings = [
      { ...common, id: "orders-pinned", roleId: "AROA12345678901234567" },
      { ...common, id: "orders-by-name", roleName: "OrdersRole" },
      { ...common, id: "orders-batch", roleName: "OrdersBatchRole" },
    ]
    const organisation = (enabled: boolean, secret: boolean) => {
      const org = new Organisation({ name: "AWS fixture" })
      new AuthenticationConfig(org, "auth", {
        awsRoleBindings: enabled ? bindings : [],
        ...(secret
          ? {
              secretClients: {
                orders: {
                  secret: "synthetic-local-test-secret",
                  audience: "graphql-api",
                },
              },
            }
          : {}),
      })
      return org
    }
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* AwsRoleProofStore
        yield* storeOrganisation(organisation(true, false))
        expect(yield* store.clients).toEqual([{ clientId: "orders", bindings }])
        yield* storeOrganisation(organisation(true, true))
        expect(yield* store.clients).toEqual([{ clientId: "orders", bindings }])
        yield* storeOrganisation(organisation(false, true))
        expect((yield* store.clients)[0]?.bindings).toEqual([])
        yield* storeOrganisation(organisation(false, false))
        expect(yield* store.clients).toEqual([])
        const now = yield* DateTime.now
        const expiry = DateTime.add(now, { seconds: 70 })
        const admissions = yield* Effect.all(
          [
            store.consume("aws-role-proof:test", expiry),
            store.consume("aws-role-proof:test", expiry),
          ],
          { concurrency: "unbounded" },
        )
        expect(admissions.sort()).toEqual([false, true])
        yield* store.cleanup(DateTime.add(now, { seconds: 60 }))
        expect(yield* store.consume("aws-role-proof:test", expiry)).toBe(false)
        yield* store.cleanup(DateTime.add(now, { seconds: 71 }))
        expect(yield* store.consume("aws-role-proof:test", expiry)).toBe(true)
      }).pipe(
        Effect.provideService(RequestTime, DateTime.nowUnsafe()),
        Effect.provide(database.layer),
      ),
    )
  }, 120000)
}
