import { NodeFileSystem } from "@effect/platform-node"
import { DateTime, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { LocalAuditLive } from "@pf/audit/local"
import {
  LocalCedarAuthorizationLive,
  LocalCedarConfig,
  LocalCedarConfigStatic,
} from "@pf/auth-local-cedar"
import { CurrentPrincipal } from "@pf/auth-policy"
import {
  DraftProcessExecutionCollectionOpsLive,
  ExecutionCollectionOpsLive,
  ListExportServiceLive,
  ProcessCollectionOps,
  ProcessCollectionOpsLive,
  ProcessDurationServiceLive,
  ResolverRuntime,
  SlaCalculationServiceLive,
  TodoCollectionOpsLive,
  type UserContext,
  filterAuthorizedProcesses,
} from "@pf/graphql-api"
import {
  ProcessCollectionQueries,
  UserDetails,
} from "@pf/graphql-db-operations"
import { storeOrganisation } from "@pf/org-to-db"
import {
  Form,
  Organisation,
  OrganisationProviderTest,
  Process,
  Role,
} from "@pf/process"
import { RequestTime } from "@pf/request-time"
import { DatabaseTest } from "@pf/service-drizzle-sqlite/test"
import {
  SqliteAuditPersistenceLive,
  SqliteDbOperationsLive,
  SqliteFileOperationsLive,
  SqliteFlowExecutionOperationsLive,
  SqliteGraphqlDbOperationsLive,
  SqliteScheduledFlowOperationsLive,
} from "@pf/sqlite-operations"
import { SqliteQueueServiceLive } from "@pf/sqlite-queue-service"
import { TodoSummaryComputationLive } from "@pf/todo-summary"
import { checkStepAuthorization } from "../../../../packages/graphql-api/src/lib/authorization"
import { buildProcessReplicationPrincipal } from "../../../../packages/graphql-api/src/lib/rxdb/process-visibility"
import { rxdbSchema } from "../../../../packages/graphql-api/src/lib/rxdb-resolvers"
import { DraftProcessEventsLive } from "../services/draft-process-events"
import { ExecutionEventsLive } from "../services/execution-events"
import {
  LocalDocumentStoreConfig,
  LocalDocumentStoreServiceLive,
} from "../services/local-document-store"
import { ProcessEventsLive } from "../services/process-events"
import { TodoEventsLive } from "../services/todo-events"
import { expect, it } from "bun:test"

const pullResult = Schema.decodeUnknownSync(
  Schema.Struct({
    documents: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        deleted: Schema.Boolean,
        name: Schema.String,
      }),
    ),
    checkpoint: Schema.NullOr(
      Schema.Struct({ id: Schema.String, updatedAt: Schema.Number }),
    ),
  }),
)

const organisation = (
  access: "granted" | "supporting" | "revoked" | "deleted",
  allowedProcessName?: string,
) => {
  const org = new Organisation({ name: "Process visibility" })
  const employee = new Role(org, "Employee", { name: "Employee" })
  const manager = new Role(org, "Manager", { name: "Manager" })
  if (access !== "deleted")
    for (let i = 0; i < 3; i++) {
      const process = new Process(org, `Work${i}`, {
        name: `Protected work ${i}`,
        purpose: "Protected purpose",
      })
      const start = new Form(process, "Start", {
        role:
          access === "granted" || allowedProcessName === `Protected work ${i}`
            ? employee
            : manager,
        supportingRoles:
          access === "granted"
            ? [manager]
            : access === "supporting"
              ? [employee]
              : [],
        form: () => ({}),
      })
      process.start(start).end()
    }
  return org
}

it("replicates scoped revocation, surviving grants and restore through real imports with deterministic checkpoints", async () => {
  const org = organisation("granted")
  const now = DateTime.nowUnsafe()
  const authorization = LocalCedarAuthorizationLive.pipe(
    Layer.provide(
      Layer.effect(
        LocalCedarConfig,
        Effect.gen(function* () {
          const config = yield* LocalCedarConfig
          return {
            ...config,
            policiesText: [
              ...config.policiesText,
              'permit(principal == PF::ProviderUser::"alternate@example.test", action == PF::Action::"complete", resource is PF::Step);',
            ],
          }
        }),
      ).pipe(Layer.provide(LocalCedarConfigStatic())),
    ),
  )
  const documentStore = LocalDocumentStoreServiceLive.pipe(
    Layer.provide(
      Layer.succeed(LocalDocumentStoreConfig, {
        baseUrl: () => "http://localhost",
        storagePath: "/tmp/opencode/execution-pull-budget-files",
        secret: "test-only",
        maxFileSize: 1024,
      }),
    ),
  )
  const app = Layer.mergeAll(
    LocalAuditLive.pipe(Layer.provide(SqliteAuditPersistenceLive)),
    DraftProcessExecutionCollectionOpsLive,
    ProcessCollectionOpsLive,
    ProcessDurationServiceLive,
    TodoCollectionOpsLive,
    TodoSummaryComputationLive,
    SqliteQueueServiceLive,
    documentStore,
    ListExportServiceLive.pipe(
      Layer.provide(documentStore),
      Layer.provide(authorization),
    ),
    DraftProcessEventsLive,
    ExecutionEventsLive,
    ProcessEventsLive,
    TodoEventsLive,
    ExecutionCollectionOpsLive.pipe(Layer.provide(SlaCalculationServiceLive)),
    authorization,
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        SqliteDbOperationsLive,
        SqliteFileOperationsLive,
        SqliteFlowExecutionOperationsLive,
        SqliteGraphqlDbOperationsLive,
        SqliteScheduledFlowOperationsLive,
      ),
    ),
    Layer.provideMerge(DatabaseTest),
    Layer.provideMerge(Layer.succeed(CurrentPrincipal, null)),
    Layer.provideMerge(OrganisationProviderTest(org)),
    Layer.provideMerge(Layer.succeed(RequestTime, now)),
    Layer.provideMerge(Layer.succeed(UserDetails, { by: "TEST", id: null })),
    Layer.provideMerge(NodeFileSystem.layer),
  )
  const runtime = ManagedRuntime.make(app)
  try {
    await runtime.runPromise(storeOrganisation(org))
    const schema = await runtime.runPromise(
      rxdbSchema.pipe(Effect.provideService(ResolverRuntime, runtime)),
    )
    const resolver = schema.resolvers?.Query?.["pullProcess"]
    if (typeof resolver !== "function") throw new Error("Missing pullProcess")
    const context: UserContext = {
      _requestTime: now,
      _userDetails: { by: "reader@example.test", id: null },
      userId: "reader",
      jwt: {
        mode: "access",
        type: "providerUser",
        properties: {
          userId: "reader",
          email: "reader@example.test",
          roles: ["/Employee"],
          orgUnitId: "/",
          orgUnitPath: "/",
        },
        aud: "graphql-api",
        iss: "http://localhost",
        sub: "reader",
        exp: 0,
      },
    }
    const userContext = (
      email: string,
      roles = ["/Employee"],
    ): UserContext => ({
      ...context,
      jwt: {
        mode: "access",
        type: "providerUser",
        properties: {
          userId: email,
          email,
          roles,
          orgUnitId: "/",
          orgUnitPath: "/",
        },
        aud: "graphql-api",
        iss: "http://localhost",
        sub: email,
        exp: 0,
      },
    })
    const delegatedContext = (generationId: string): UserContext => ({
      ...context,
      jwt: {
        mode: "access",
        type: "providerUser",
        properties: {
          userId: "reader",
          email: "reader@example.test",
          roles: ["/Employee"],
          orgUnitId: "/",
          orgUnitPath: "/",
          delegation: {
            id: "delegation",
            generationId,
            name: "Delegate",
            expiresAt: 2000000000000,
          },
        },
        aud: "graphql-api",
        iss: "http://localhost",
        sub: "reader",
        exp: 0,
      },
    })
    type Checkpoint = { id: string; updatedAt: number } | null
    const pull = async (checkpoint: Checkpoint, caller = context, limit = 10) =>
      pullResult(
        await runtime.runPromise(
          Reflect.apply(resolver, undefined, [
            undefined,
            { limit, checkpoint },
            caller,
          ]),
        ),
      )
    const reimport = (access: Parameters<typeof organisation>[0]) =>
      runtime.runPromise(storeOrganisation(organisation(access)))
    const b = userContext("retained@example.test", ["/Manager"])
    const c = userContext("never@example.test")
    const alternate = userContext("alternate@example.test", [])
    const before = await pull(null)
    expect(before.documents).toHaveLength(3)
    expect(before.documents.every((doc) => !doc.deleted)).toBe(true)
    expect((await pull(null, b)).documents).toHaveLength(3)
    expect((await pull(null, alternate)).documents).toHaveLength(3)
    const delegated = await pull(null, delegatedContext("original"))
    expect(delegated.documents).toHaveLength(3)
    // An aborted import must retain access and the replication revision.
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const rolledBack = yield* sql
          .withTransaction(
            storeOrganisation(organisation("revoked")).pipe(
              Effect.andThen(Effect.fail("abort")),
            ),
          )
          .pipe(Effect.isFailure)
        expect(rolledBack).toBe(true)
      }),
    )
    expect((await pull(before.checkpoint)).documents).toEqual([])
    const staleEvent = await runtime.runPromise(
      Effect.gen(function* () {
        const ops = yield* ProcessCollectionOps
        return yield* Effect.forEach(
          yield* ops.pull(null, 10),
          ops.mapToGraphql,
        )
      }),
    )
    // Primary grant is gone, supporting grant survives. Reuse RequestTime to
    // exercise repeated imports inside the same clock tick.
    await reimport("supporting")
    const surviving = await pull(before.checkpoint)
    expect(surviving.documents).toHaveLength(3)
    expect(surviving.documents.every((doc) => !doc.deleted)).toBe(true)
    await reimport("revoked")
    const tombstones: (typeof before.documents)[number][] = []
    let checkpoint = surviving.checkpoint
    for (let i = 0; i < 3; i++) {
      const page = await pull(checkpoint, context, 1)
      expect(page.documents).toHaveLength(1)
      tombstones.push(...page.documents)
      checkpoint = page.checkpoint
    }
    expect(tombstones).toEqual(
      before.documents.map((doc) => ({ id: doc.id, name: "", deleted: true })),
    )
    expect((await pull(checkpoint)).documents).toEqual([])
    expect(
      (await pull(delegated.checkpoint, delegatedContext("original")))
        .documents,
    ).toEqual(tombstones)
    expect(
      (await pull(null, delegatedContext("replacement"))).documents,
    ).toEqual([])
    const never = await pull(null, c)
    expect(never.documents).toEqual([])
    expect((await pull(never.checkpoint, c)).checkpoint).toEqual(
      never.checkpoint,
    )
    expect(
      (await pull(null, userContext("reader@example.test", ["/Unassigned"])))
        .documents,
    ).toEqual([])
    expect(
      (await pull(before.checkpoint, b)).documents.every((doc) => !doc.deleted),
    ).toBe(true)
    expect(
      (await pull(before.checkpoint, alternate)).documents.every(
        (doc) => !doc.deleted,
      ),
    ).toBe(true)
    expect(
      await runtime.runPromise(
        checkStepAuthorization(context, "/Work0/Start").pipe(Effect.isFailure),
      ),
    ).toBe(true)
    const streamed = await runtime.runPromise(
      filterAuthorizedProcesses(
        staleEvent,
        await runtime.runPromise(buildProcessReplicationPrincipal(context)),
      ),
    )
    expect(
      streamed.map((doc) => ({
        id: doc.id,
        name: doc.name,
        deleted: doc.deleted,
      })),
    ).toEqual(tombstones)
    expect(
      streamed.every(
        (doc) =>
          doc.path === "" &&
          doc.startStepPath === "" &&
          doc.purpose === "" &&
          !doc.canSkipScheduleWaits,
      ),
    ).toBe(true)
    expect(
      await runtime.runPromise(
        filterAuthorizedProcesses(
          staleEvent,
          await runtime.runPromise(buildProcessReplicationPrincipal(c)),
        ),
      ),
    ).toEqual([])
    await reimport("granted")
    const restored = await pull(checkpoint)
    expect(restored.documents).toEqual(before.documents)
    // Late revocation notifications reload current state instead of applying a
    // stale snapshot. Offline revoke/regrant must converge to the latest grant.
    await reimport("revoked")
    await reimport("granted")
    expect((await pull(restored.checkpoint)).documents).toEqual(
      before.documents,
    )
    const latest = await runtime.runPromise(
      filterAuthorizedProcesses(
        streamed,
        await runtime.runPromise(buildProcessReplicationPrincipal(context)),
      ),
    )
    expect(
      latest.every((doc) => !doc.deleted && doc.name.startsWith("Protected")),
    ).toBe(true)
    // Preserve the authorized-pagination contract at the real persistence
    // boundary: two denied rows must not hide a later allowed process.
    const rawRows = await runtime.runPromise(
      Effect.gen(function* () {
        const ops = yield* ProcessCollectionOps
        return yield* ops.pull(null, 10)
      }),
    )
    const lastRow = rawRows.at(-1)
    if (!lastRow) throw new Error("Missing pagination fixture")
    await runtime.runPromise(
      storeOrganisation(organisation("revoked", lastRow.name)),
    )
    const allowedPage = await pull(null, c, 2)
    expect(allowedPage.documents.map((doc) => doc.id)).toEqual([lastRow.id])
    expect(allowedPage.checkpoint?.id).toBe(lastRow.id)
    expect((await pull(allowedPage.checkpoint, c, 2)).documents).toEqual([])

    await reimport("deleted")
    const deleted = await pull(restored.checkpoint)
    expect(deleted.documents).toEqual(tombstones)
    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const queries = yield* ProcessCollectionQueries
        return yield* queries.getObservedProcessIds(
          "arbitrary-untrusted-scope",
          before.documents.map((doc) => doc.id),
        )
      }),
    )
    expect(observed).toEqual([])
  } finally {
    await runtime.dispose()
  }
})
