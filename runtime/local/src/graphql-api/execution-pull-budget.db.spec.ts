import { NodeFileSystem } from "@effect/platform-node"
import { DateTime, Effect, Layer, ManagedRuntime, Schema } from "effect"
import * as Statement from "effect/sql/Statement"
import { LocalAuditLive } from "@pf/audit/local"
import {
  LocalCedarAuthorizationLive,
  LocalCedarConfig,
  LocalCedarConfigStatic,
} from "@pf/auth-local-cedar"
import { CurrentPrincipal } from "@pf/auth-policy"
import * as dbSchema from "@pf/drizzle-sqlite"
import {
  DraftProcessExecutionCollectionOpsLive,
  ExecutionCollectionOpsLive,
  ListExportServiceLive,
  ProcessCollectionOpsLive,
  ResolverRuntime,
  SlaCalculationServiceLive,
  TodoCollectionOpsLive,
  type UserContext,
} from "@pf/graphql-api"
import { UserDetails } from "@pf/graphql-db-operations"
import { storeOrganisation } from "@pf/org-to-db"
import {
  Form,
  Organisation,
  OrganisationProviderTest,
  Process,
  Role,
} from "@pf/process"
import { RequestTime } from "@pf/request-time"
import {
  DatabaseTest,
  TypedSqliteDrizzle,
} from "@pf/service-drizzle-sqlite/test"
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
      Schema.Struct({ id: Schema.String, canAbandonExecution: Schema.Boolean }),
    ),
    checkpoint: Schema.NullOr(
      Schema.Struct({ id: Schema.String, updatedAt: Schema.Number }),
    ),
  }),
)

it("pulls 50 old unfinished executions within a bounded SQL budget, preserving abandonment decisions", async () => {
  const org = new Organisation({ name: "Execution pull budget" })
  const role = new Role(org, "Employee", { name: "Employee" })
  const process = new Process(org, "Work", {
    name: "Work",
    purpose: "Pull regression",
  })
  const start = new Form(process, "Start", { role, form: () => ({}) })
  const review = new Form(process, "Review", { role, form: () => ({}) })
  process.start(start).next(review).end()
  const now = DateTime.makeUnsafe("2026-09-25T00:00:00Z")
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
              `
        permit(principal, action == PF::Action::"view", resource is PF::Execution);
        permit(principal, action == PF::Action::"abandon", resource == PF::Step::"/Work/Start");
      `,
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
    await runtime.runPromise(
      Effect.gen(function* () {
        yield* storeOrganisation(org)
        const db = yield* TypedSqliteDrizzle
        const [flow] = yield* db.select().from(dbSchema.flow)
        const [storedProcess] = yield* db.select().from(dbSchema.process)
        expect(flow).toBeDefined()
        yield* db.insert(dbSchema.processState).values({
          id: "state",
          processId: storedProcess!.id,
          startStepId: flow!.sourceStepId,
          state: {},
        })
        yield* db.insert(dbSchema.processExecution).values(
          Array.from({ length: 50 }, (_, index) => ({
            id: `execution-${String(index).padStart(2, "0")}`,
            processStateId: "state",
          })),
        )
        // Active/failed Todos and pending targets must take precedence over the
        // permitted start-step fallback. Deleted Todos must not affect it.
        yield* db.insert(dbSchema.toDo).values([
          {
            id: "active",
            processExecutionId: "execution-00",
            flowId: flow!.id,
          },
          {
            id: "failed",
            processExecutionId: "execution-01",
            flowId: flow!.id,
            failureReason: "failed",
          },
          {
            id: "deleted",
            processExecutionId: "execution-04",
            flowId: flow!.id,
            failureReason: "failed",
            _deleted: true,
          },
          {
            // Denied failed work must not override the permitted pending source.
            id: "failed-with-pending-source",
            processExecutionId: "execution-03",
            flowId: flow!.id,
            failureReason: "failed",
          },
        ])
        yield* db.insert(dbSchema.scheduledFlow).values([
          {
            // Permitted pending work must not override the denied active Todo.
            id: "source-with-active-todo",
            processExecutionId: "execution-00",
            sourceStepId: flow!.sourceStepId,
          },
          {
            id: "target",
            processExecutionId: "execution-02",
            sourceStepId: flow!.sourceStepId,
            targetStepId: flow!.targetStepId,
          },
          {
            id: "source",
            processExecutionId: "execution-03",
            sourceStepId: flow!.sourceStepId,
          },
        ])
      }),
    )
    const schema = await runtime.runPromise(
      rxdbSchema.pipe(Effect.provideService(ResolverRuntime, runtime)),
    )
    const resolver = schema.resolvers?.Query?.["pullExecution"]
    if (typeof resolver !== "function") throw new Error("Missing pullExecution")
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
    const call = Reflect.apply(resolver, undefined, [
      undefined,
      {
        limit: 50,
        checkpoint: {
          id: "",
          updatedAt: DateTime.toEpochMillis(now) + 86400000,
        },
        includeRunning: true,
        historySince: DateTime.toEpochMillis(now) + 86400000,
      },
      context,
    ])
    let queries = 0
    const result = pullResult(
      await runtime.runPromise(
        call.pipe(
          Effect.provideService(Statement.CurrentTransformer, (statement) =>
            Effect.sync(() => {
              queries++
              return statement
            }),
          ),
        ),
      ),
    )
    expect(result.documents).toHaveLength(50)
    expect(
      result.documents
        .filter((document) => !document.canAbandonExecution)
        .map((document) => document.id),
    ).toEqual(["execution-00", "execution-01", "execution-02"])
    expect(result.checkpoint?.id).toBe("execution-49")
    // Leaves room for assembly/calendar reads, but forbids hundreds of serial
    // database round trips for a single replication page (the hosted timeout).
    expect(queries).toBeLessThan(40)
  } finally {
    await runtime.dispose()
  }
})
