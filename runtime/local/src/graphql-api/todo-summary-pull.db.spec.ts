import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeFileSystem } from "@effect/platform-node"
import {
  ConfigProvider,
  DateTime,
  Effect,
  Layer,
  ManagedRuntime,
  Schema,
} from "effect"
import * as Statement from "effect/sql/Statement"
import { LocalAuditLive } from "@pf/audit/local"
import {
  LocalCedarAuthorizationLive,
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
import { TodoQueries, UserDetails } from "@pf/graphql-db-operations"
import { TursoLive } from "@pf/layer-turso-local"
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
  TypedSqliteDrizzle,
  TypedSqliteDrizzleLayer,
} from "@pf/service-drizzle-sqlite"
import { DatabaseTestFile } from "@pf/service-drizzle-sqlite/test-file"
import {
  SqliteAuditPersistenceLive,
  SqliteDbOperationsLive,
  SqliteFileOperationsLive,
  SqliteFlowExecutionOperationsLive,
  SqliteGraphqlDbOperationsLive,
  SqliteScheduledFlowOperationsLive,
} from "@pf/sqlite-operations"
import { SqliteQueueServiceLive } from "@pf/sqlite-queue-service"
import {
  TodoSummaryComputation,
  TodoSummaryComputationLive,
} from "@pf/todo-summary"
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

const decodePull = Schema.decodeUnknownSync(
  Schema.Struct({
    documents: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        summary: Schema.Array(
          Schema.Struct({ label: Schema.String, value: Schema.String }),
        ),
      }),
    ),
  }),
)

it("pulls 50 Todo summaries with a constant SQL budget and skips forms without summaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pf-summary-"))
  const databasePath = join(directory, "pf.db")
  const org = new Organisation({ name: "Summary pull" })
  const role = new Role(org, "Employee", { name: "Employee" })
  const process = new Process(org, "Work", {
    name: "Work",
    purpose: "Summary regression",
  })
  const start = new Form(process, "Start", {
    role,
    form: () => ({
      title: Schema.String,
      items: Schema.Array(Schema.Struct({ name: Schema.String })),
    }),
  })
  const started = process.start(start)
  const completed = new Form(started, "Completed", { role, form: () => ({}) })
  const afterCompleted = started.next(completed)
  const review = new Form(afterCompleted, "Review", {
    role,
    forEach: { items: (state) => Effect.succeed(state.items) },
    form: () => ({}),
    summary: (state, ctx, item) =>
      Effect.gen(function* () {
        return {
          Title: state.title,
          Item: item.name,
          Starter: ctx.step.start.providerUser.name,
          Completer: ctx.step.completed.providerUser.name,
          Display: yield* ctx.providerUserDisplay.display("pvu-reader"),
        }
      }),
  })
  afterCompleted.next(review).end()
  const plain = new Form(started, "Plain", { role, form: () => ({}) })
  started.next(plain).end()
  const now = DateTime.makeUnsafe("2026-10-01T10:00:00Z")
  const context: UserContext = {
    _requestTime: now,
    _userDetails: { by: "reader@example.test", id: "reader" },
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

  // Run the repository migrations, then reopen the file with the actual local Turso client.
  await Effect.runPromise(
    Effect.void.pipe(Effect.provide(DatabaseTestFile(databasePath))),
  )
  const database = TypedSqliteDrizzleLayer.pipe(
    Layer.provideMerge(TursoLive),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({ SQLITE_DATABASE_PATH: databasePath }),
      ),
    ),
  )
  const authorization = LocalCedarAuthorizationLive.pipe(
    Layer.provide(LocalCedarConfigStatic()),
  )
  const documentStore = LocalDocumentStoreServiceLive.pipe(
    Layer.provide(
      Layer.succeed(LocalDocumentStoreConfig, {
        baseUrl: () => "http://localhost",
        storagePath: join(directory, "files"),
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
    Layer.provideMerge(database),
    Layer.provideMerge(Layer.succeed(CurrentPrincipal, null)),
    Layer.provideMerge(OrganisationProviderTest(org)),
    Layer.provideMerge(Layer.succeed(RequestTime, now)),
    Layer.provideMerge(Layer.succeed(UserDetails, context._userDetails!)),
    Layer.provideMerge(NodeFileSystem.layer),
  )
  const runtime = ManagedRuntime.make(app)
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        yield* storeOrganisation(org)
        const db = yield* TypedSqliteDrizzle
        const [storedProcess] = yield* db.select().from(dbSchema.process)
        const steps = yield* db.select().from(dbSchema.step)
        const flows = yield* db.select().from(dbSchema.flow)
        const [unit] = yield* db.select().from(dbSchema.orgUnit)
        const startId = steps.find((step) => step.path === "/Work/Start")!.id
        const completedFlow = flows.find(
          (flow) =>
            flow.targetStepId ===
            steps.find((step) => step.path === "/Work/Completed")!.id,
        )!.id
        const reviewFlow = flows.find(
          (flow) =>
            flow.targetStepId ===
            steps.find((step) => step.path === "/Work/Review")!.id,
        )!.id
        const plainFlow = flows.find(
          (flow) =>
            flow.targetStepId ===
            steps.find((step) => step.path === "/Work/Plain")!.id,
        )!.id
        yield* db.insert(dbSchema.user).values([
          {
            id: "reader",
            sub: "reader@example.test",
            provider: "test",
            createdAt: now,
          },
          {
            id: "system",
            sub: "system@example.test",
            provider: "test",
            createdAt: now,
          },
        ])
        yield* db.insert(dbSchema.providerUser).values({
          id: "pvu-reader",
          userId: "reader",
          email: "reader@example.test",
          name: "Reader Name",
          firstName: "Reader",
          lastName: "Name",
          picture: "",
          locale: "en",
          orgUnitId: unit!.id,
        })
        for (let index = 0; index < 51; index++) {
          const suffix = String(index).padStart(2, "0")
          yield* db.insert(dbSchema.processState).values({
            id: `state-${suffix}`,
            processId: storedProcess!.id,
            startStepId: startId,
            startedByUserId: "reader",
            state: {
              title: `Work ${suffix}`,
              items: [{ name: `Item ${suffix}` }],
            },
          })
          yield* db.insert(dbSchema.processExecution).values({
            id: `execution-${suffix}`,
            processStateId: `state-${suffix}`,
            createdAt: now,
          })
          yield* db.insert(dbSchema.toDo).values([
            {
              id: `completed-${suffix}`,
              processExecutionId: `execution-${suffix}`,
              flowId: completedFlow,
              completedByUserId: "system",
              _deleted: true,
              updatedAt: now,
            },
            {
              id: `todo-${suffix}`,
              processExecutionId: `execution-${suffix}`,
              flowId: index === 50 ? plainFlow : reviewFlow,
              itemData: { name: `Item ${suffix}` },
              updatedAt: now,
            },
          ])
        }
      }),
    )

    const schema = await runtime.runPromise(
      rxdbSchema.pipe(Effect.provideService(ResolverRuntime, runtime)),
    )
    const pull = schema.resolvers?.Query?.["pullTodo"]
    if (typeof pull !== "function") throw new Error("Missing pullTodo")
    const measure = async (
      limit: number,
      checkpoint?: { id: string; updatedAt: number },
    ) => {
      let statements = 0
      const startedAt = performance.now()
      const result = decodePull(
        await runtime.runPromise(
          Reflect.apply(pull, undefined, [
            undefined,
            { limit, checkpoint },
            context,
          ]).pipe(
            Effect.provideService(Statement.CurrentTransformer, (statement) =>
              Effect.sync(() => {
                statements++
                return statement
              }),
            ),
          ),
        ),
      )
      return { result, statements, milliseconds: performance.now() - startedAt }
    }
    const page = await measure(50)
    expect(page.result.documents).toHaveLength(50)
    for (const [index, document] of page.result.documents.entries()) {
      const suffix = String(index).padStart(2, "0")
      expect(document).toEqual({
        id: `todo-${suffix}`,
        summary: [
          { label: "Title", value: `Work ${suffix}` },
          { label: "Item", value: `Item ${suffix}` },
          { label: "Starter", value: "Reader Name" },
          { label: "Completer", value: "system@example.test" },
          { label: "Display", value: "Reader Name" },
        ],
      })
    }
    console.info(
      JSON.stringify({
        fixture: "50 Todos / 50 executions / local Turso",
        statements: page.statements,
        milliseconds: page.milliseconds,
      }),
    )
    const smallPage = await measure(1)
    expect(page.statements).toBe(smallPage.statements)
    expect(page.statements).toBeLessThanOrEqual(8)

    // The final page has only a form without a summary, so no completion reads or display lookups.
    const plainPage = await measure(50, {
      id: "todo-49",
      updatedAt: DateTime.toEpochMillis(now),
    })
    expect(plainPage.result.documents).toEqual([{ id: "todo-50", summary: [] }])
    const plainRows = await runtime.runPromise(
      Effect.gen(function* () {
        const todos = yield* TodoQueries
        return yield* todos.getTodos(["todo-50"])
      }),
    )
    let plainEnrichmentStatements = 0
    await runtime.runPromise(
      Effect.gen(function* () {
        const summaries = yield* TodoSummaryComputation
        expect(yield* summaries.enrichWithSummaries(plainRows)).toEqual(
          plainRows,
        )
      }).pipe(
        Effect.provideService(Statement.CurrentTransformer, (statement) =>
          Effect.sync(() => {
            plainEnrichmentStatements++
            return statement
          }),
        ),
      ),
    )
    expect(plainEnrichmentStatements).toBe(1)
    expect(
      await runtime.runPromise(
        Effect.gen(function* () {
          const summaries = yield* TodoSummaryComputation
          return yield* summaries.enrichWithSummaries([])
        }),
      ),
    ).toEqual([])
  } finally {
    await runtime.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
