import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as SqlClient from "@effect/sql/SqlClient"
import { DateTime, Effect, FiberRef, Layer, Scope } from "effect"
import * as schema from "@pf/drizzle-sqlite"
import {
  CompletedJobOperations,
  FlowExecutionOperations,
  UserDetails,
  type UserDetailsValue,
} from "@pf/graphql-db-operations"
import {
  EXECUTION_EVENT_QUEUE,
  ExecutionFromJobPublishError,
  ExecutionFromJobPublisher,
  PROCESS_EVENT_QUEUE,
  ProcessFromJobPublishError,
  ProcessFromJobPublisher,
  TODO_EVENT_QUEUE,
  TodoFromJobPublishError,
  TodoFromJobPublisher,
  executionEventHandler,
  processEventHandler,
  todoEventHandler,
} from "@pf/job-handler"
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
  DatabaseTestFile,
  TypedSqliteDrizzle,
} from "@pf/service-drizzle-sqlite/test-file"
import {
  SqliteCompletedJobOperationsLive,
  SqliteDbOperationsLive,
  SqliteFlowExecutionOperationsLive,
  SqliteGraphqlDbOperationsLive,
} from "@pf/sqlite-operations"
import { TodoSummaryComputationLive } from "@pf/todo-summary"
import { Database } from "bun:sqlite"
import { expect, it } from "bun:test"

for (const queue of [
  TODO_EVENT_QUEUE,
  PROCESS_EVENT_QUEUE,
  EXECUTION_EVENT_QUEUE,
]) {
  it(`${queue} does not lock completion outbox acknowledgements while publishing`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "event-publisher-lock-"))
    const filename = join(directory, "pf.db")
    const org = new Organisation({ name: "Event lock regression" })
    const role = new Role(org, "Manager", { name: "Manager" })
    const process = new Process(org, "Review", {
      name: "Review",
      purpose: "Regression",
    })
    const start = new Form(process, "Start", {
      name: "Start",
      role,
      form: () => ({}),
    })
    const review = new Form(process, "Review", {
      name: "Review",
      role,
      form: () => ({}),
    })
    process.start(start).next(review).end()
    const now = DateTime.unsafeMake("2026-09-08T07:41:38Z")
    const database = DatabaseTestFile(filename)
    const orgLayer = OrganisationProviderTest(org)
    const layers = Layer.mergeAll(
      SqliteDbOperationsLive,
      SqliteGraphqlDbOperationsLive,
      SqliteCompletedJobOperationsLive,
      SqliteFlowExecutionOperationsLive,
      TodoSummaryComputationLive.pipe(
        Layer.provide(SqliteGraphqlDbOperationsLive),
        Layer.provide(orgLayer),
      ),
      Layer.succeed(RequestTime, FiberRef.unsafeMake(now)),
      Layer.succeed(
        UserDetails,
        FiberRef.unsafeMake<UserDetailsValue>({ by: "TEST", id: null }),
      ),
    ).pipe(Layer.provideMerge(database))

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            // Match AWS's ordinary transaction mode, using a real SQLite connection.
            Object.assign(sql, {
              withTransaction: SqlClient.makeWithTransaction({
                transactionTag: SqlClient.TransactionConnection,
                spanAttributes: [],
                acquireConnection: Effect.gen(function* () {
                  const scope = yield* Scope.make()
                  const connection = yield* Scope.extend(sql.reserve, scope)
                  return [scope, connection] as const
                }),
                begin: (connection) =>
                  connection.executeUnprepared(
                    "BEGIN IMMEDIATE",
                    [],
                    undefined,
                  ),
                commit: (connection) =>
                  connection.executeUnprepared("COMMIT", [], undefined),
                rollback: (connection) =>
                  connection.executeUnprepared("ROLLBACK", [], undefined),
                savepoint: (connection, id) =>
                  connection.executeUnprepared(
                    `SAVEPOINT event_${id}`,
                    [],
                    undefined,
                  ),
                rollbackSavepoint: (connection, id) =>
                  connection.executeUnprepared(
                    `ROLLBACK TO SAVEPOINT event_${id}`,
                    [],
                    undefined,
                  ),
              }),
            })
            yield* storeOrganisation(org)
            const db = yield* TypedSqliteDrizzle
            const [flow] = yield* db.select().from(schema.flow)
            const [storedProcess] = yield* db.select().from(schema.process)
            expect(flow).toBeDefined()
            expect(storedProcess).toBeDefined()
            yield* db.insert(schema.processState).values({
              id: "state",
              processId: storedProcess!.id,
              startStepId: flow!.sourceStepId,
              state: {},
            })
            yield* db
              .insert(schema.processExecution)
              .values({ id: "execution", processStateId: "state" })
            yield* db.insert(schema.toDo).values({
              id: "todo",
              processExecutionId: "execution",
              flowId: flow!.id,
            })
            const outbox = yield* FlowExecutionOperations
            yield* outbox.insertFlowDispatchJobs([
              {
                sourceScheduledFlowId: "step-completion:todo",
                storageQueue: "completion-outbox",
                processExecutionId: "execution",
                logicalJobId: "event:todo",
                queue,
                payload: {},
                retryLimit: null,
                scheduledAt: null,
                sequence: 0,
              },
            ])
            const [dispatch] = yield* outbox.claimFlowDispatchJobs(
              "step-completion:todo",
              now,
              DateTime.add(now, { minutes: 5 }),
              "receipt",
            )
            expect(dispatch).toBeDefined()
            const producer = yield* Effect.acquireRelease(
              Effect.sync(() => new Database(filename)),
              (connection) => Effect.sync(() => connection.close()),
            )
            producer.exec("PRAGMA busy_timeout = 0")
            let acknowledgementError: unknown
            let publishes = 0
            let failPublication = true
            const publish = Effect.sync(() => {
              publishes += 1
              expect(
                producer
                  .query("SELECT id FROM pf_completed_job WHERE job_id = ?")
                  .all("event-job"),
              ).toHaveLength(0)
              try {
                producer
                  .query(
                    "DELETE FROM pf_job_queue WHERE id = ? AND claim_receipt = ?",
                  )
                  .run(dispatch!.id, "receipt")
              } catch (error) {
                acknowledgementError = error
              }
            }).pipe(
              Effect.flatMap(() =>
                failPublication
                  ? Effect.fail("publication failed")
                  : Effect.void,
              ),
            )
            const publishers = Layer.mergeAll(
              Layer.succeed(TodoFromJobPublisher, {
                publishTodosCreated: () =>
                  publish.pipe(
                    Effect.mapError(
                      (cause) =>
                        new TodoFromJobPublishError({
                          todoIds: ["todo"],
                          cause,
                        }),
                    ),
                  ),
              }),
              Layer.succeed(ProcessFromJobPublisher, {
                publishProcessChanged: () =>
                  publish.pipe(
                    Effect.as("published" as const),
                    Effect.mapError(
                      (cause) =>
                        new ProcessFromJobPublishError({
                          processId: storedProcess!.id,
                          cause,
                        }),
                    ),
                  ),
              }),
              Layer.succeed(ExecutionFromJobPublisher, {
                publishExecutionChanged: () =>
                  publish.pipe(
                    Effect.as("published" as const),
                    Effect.mapError(
                      (cause) =>
                        new ExecutionFromJobPublishError({
                          executionId: "execution",
                          cause,
                        }),
                    ),
                  ),
              }),
            )
            const job = {
              jobId: "event-job",
              receipt: "event-receipt",
              queue,
              attempts: 1,
              maxAttempts: 5,
              availableAt: now,
              lockedUntil: now,
            }
            const handle = Effect.gen(function* () {
              if (queue === TODO_EVENT_QUEUE)
                return yield* todoEventHandler.handle({
                  ...job,
                  payload: { todoIds: ["todo"] },
                })
              if (queue === PROCESS_EVENT_QUEUE)
                return yield* processEventHandler.handle({
                  ...job,
                  payload: { processId: storedProcess!.id },
                })
              return yield* executionEventHandler.handle({
                ...job,
                payload: { executionId: "execution" },
              })
            })
            const completed = yield* CompletedJobOperations
            yield* handle.pipe(Effect.provide(publishers), Effect.flip)
            expect(yield* completed.isJobCompleted(queue, job.jobId)).toBe(
              false,
            )
            expect(acknowledgementError).toBeUndefined()
            failPublication = false
            yield* handle.pipe(Effect.provide(publishers))
            expect(acknowledgementError).toBeUndefined()
            expect(
              yield* outbox.queryFlowDispatchJobs("step-completion:todo"),
            ).toHaveLength(0)
            expect(yield* completed.isJobCompleted(queue, job.jobId)).toBe(true)
            yield* handle.pipe(Effect.provide(publishers))
            expect(publishes).toBe(2)
          }).pipe(Effect.provide(layers)),
        ),
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
}
