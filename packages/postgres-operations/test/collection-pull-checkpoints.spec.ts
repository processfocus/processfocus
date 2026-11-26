// biome-ignore-all lint/style/noNonNullAssertion: test assertions

import { expect, it } from "@effect/vitest"
import { eq, sql } from "drizzle-orm"
import { DateTime, Deferred, Effect, Fiber, Layer } from "effect"
import { SqlClient } from "effect/sql"
import * as schema from "@pf/drizzle-postgres"
import {
  DraftProcessExecutionQueries,
  ExecutionQueries,
  ProcessCollectionQueries,
  TodoQueries,
  UserDetails,
  type UserDetailsValue,
} from "@pf/graphql-db-operations"
import { DbOperations } from "@pf/org-to-db/db-operations"
import { RequestTime } from "@pf/request-time"
import { PostgresDraftProcessExecutionQueriesLive } from "../src/lib/draft-process-execution"
import { PostgresExecutionQueriesLive } from "../src/lib/execution-queries"
import { PostgresDbOperationsLive } from "../src/lib/org-to-db"
import { PostgresProcessCollectionQueriesLive } from "../src/lib/query-processes"
import { PostgresTodoQueriesLive } from "../src/lib/todo-queries"
import { PostgresTest, TypedPostgresDrizzle } from "./postgres-test"

const userId = "usr-checkpoint"
const timestamp = DateTime.makeUnsafe("2040-01-01T00:00:00.000Z")
const checkpointTimestamp = sql`TIMESTAMPTZ '2026-07-23T00:00:00.000107Z'`
const replicationHeadTimestamp = sql`TIMESTAMPTZ '2026-07-24T00:00:00.000Z'`
const completionTimestamp = sql`TIMESTAMPTZ '2026-07-25T00:00:00.000Z'`
const incrementalStartMillis = Date.parse("2026-07-23T12:00:00.000Z")
const replicationHeadMillis = Date.parse("2026-07-24T00:00:00.000Z")
const completionMillis = Date.parse("2026-07-25T00:00:00.000Z")
const UserDetailsTest = Layer.succeed(UserDetails, {
  by: "checkpoint@example.com",
  id: userId,
} as UserDetailsValue)
const TestLayer = Layer.provideMerge(
  Layer.mergeAll(
    PostgresDbOperationsLive,
    Layer.succeed(RequestTime, timestamp),
    PostgresDraftProcessExecutionQueriesLive,
    PostgresExecutionQueriesLive,
    PostgresProcessCollectionQueriesLive,
    PostgresTodoQueriesLive,
    UserDetailsTest,
  ),
  PostgresTest,
)

const seedCollections = Effect.gen(function* () {
  const db = yield* TypedPostgresDrizzle
  yield* db.insert(schema.user).values({
    id: userId,
    provider: "test",
    sub: "checkpoint",
    createdAt: timestamp,
  })
  yield* db.insert(schema.orgUnit).values({
    id: "ou-checkpoint",
    name: "Checkpoint",
    orgUnitLevel: "organisation",
    path: "/checkpoint",
  })
  yield* db.insert(schema.role).values({
    id: "role-checkpoint",
    orgUnitId: "ou-checkpoint",
    name: "Employee",
    path: "/Employee",
  })

  for (const suffix of ["a", "b"]) {
    const processId = `prc-checkpoint-${suffix}`
    const startStepId = `step-checkpoint-start-${suffix}`
    const targetStepId = `step-checkpoint-target-${suffix}`
    const executionStateId = `pst-checkpoint-execution-${suffix}`
    const executionId = `pex-checkpoint-${suffix}`
    const flowId = `flow-checkpoint-${suffix}`

    yield* db.insert(schema.process).values({
      id: processId,
      orgUnitId: "ou-checkpoint",
      name: `Process ${suffix}`,
      path: `/checkpoint/${suffix}`,
      purpose: "Test pull checkpoints",
      updatedAt: checkpointTimestamp,
    })
    yield* db.insert(schema.step).values([
      {
        id: startStepId,
        name: "Start",
        path: `/checkpoint/${suffix}/start`,
        purpose: "Start",
        processId,
      },
      {
        id: targetStepId,
        name: "Complete",
        path: `/checkpoint/${suffix}/complete`,
        purpose: "Complete",
        processId,
        roleId: "role-checkpoint",
      },
    ])
    yield* db.insert(schema.flow).values({
      id: flowId,
      flowKey: flowId,
      sourceStepId: startStepId,
      targetStepId,
    })
    yield* db.insert(schema.processState).values([
      {
        id: executionStateId,
        processId,
        startStepId,
        state: {},
      },
      {
        id: `pst-checkpoint-draft-${suffix}`,
        processId,
        startStepId,
        startedByUserId: userId,
        state: {},
        updatedAt: checkpointTimestamp,
      },
    ])
    yield* db.insert(schema.processExecution).values({
      id: executionId,
      processStateId: executionStateId,
      updatedAt: checkpointTimestamp,
    })
    yield* db.insert(schema.toDo).values({
      id: `todo-checkpoint-${suffix}`,
      processExecutionId: executionId,
      flowId,
      updatedAt: checkpointTimestamp,
    })
  }
})

const extraLiveTodoIds = Array.from(
  { length: 49 },
  (_, index) => `todo-checkpoint-live-${String(index).padStart(2, "0")}`,
)

const seedTodoHistory = Effect.gen(function* () {
  const db = yield* TypedPostgresDrizzle
  yield* db.insert(schema.toDo).values(
    extraLiveTodoIds.map((id) => ({
      id,
      processExecutionId: "pex-checkpoint-b",
      flowId: "flow-checkpoint-b",
      updatedAt: checkpointTimestamp,
    })),
  )
  yield* db.insert(schema.toDo).values({
    id: "todo-checkpoint-deleted-head",
    processExecutionId: "pex-checkpoint-b",
    flowId: "flow-checkpoint-b",
    updatedAt: replicationHeadTimestamp,
    _deleted: true,
  })
})

it.layer(TestLayer, { timeout: "60 seconds" })(
  "collection pull checkpoints",
  (it) => {
    it.effect(
      "advances equal-timestamp collections to a final empty page",
      () =>
        Effect.gen(function* () {
          const todos = yield* TodoQueries
          expect(yield* todos.getTodoReplicationHead()).toBeNull()
          yield* seedCollections
          yield* seedTodoHistory

          const drafts = yield* DraftProcessExecutionQueries
          const draftA = yield* drafts.pullDraftProcessExecution(null, 1)
          const draftB = yield* drafts.pullDraftProcessExecution(
            { id: draftA[0]!.id, updatedAt: draftA[0]!.updatedAt },
            1,
          )
          expect(draftA.map(({ id }) => id)).toEqual(["pst-checkpoint-draft-a"])
          expect(draftB.map(({ id }) => id)).toEqual(["pst-checkpoint-draft-b"])
          expect(
            yield* drafts.pullDraftProcessExecution(
              { id: draftB[0]!.id, updatedAt: draftB[0]!.updatedAt },
              1,
            ),
          ).toEqual([])

          const processes = yield* ProcessCollectionQueries
          const processA = yield* processes.pullProcess(null, 1)
          const processB = yield* processes.pullProcess(
            { id: processA[0]!.id, updatedAt: processA[0]!.updatedAt },
            1,
          )
          expect(processA.map(({ id }) => id)).toEqual(["prc-checkpoint-a"])
          expect(processB.map(({ id }) => id)).toEqual(["prc-checkpoint-b"])
          // Live authorization reads the same current metadata without joining
          // execution statistics or the collection-wide start-step view.
          expect(
            yield* processes.getProcessMetadata(["prc-checkpoint-a"]),
          ).toMatchObject([
            {
              id: "prc-checkpoint-a",
              name: "Process a",
              path: "/checkpoint/a",
              startStepPath: "/checkpoint/a/start",
              deleted: false,
              updatedAt: processA[0]!.updatedAt,
            },
          ])
          expect(
            yield* processes.pullProcess(
              { id: processB[0]!.id, updatedAt: processB[0]!.updatedAt },
              1,
            ),
          ).toEqual([])

          // Event revisions must pass the whole collection head, including when
          // the next changed process has a lower ID and an older revision.
          const sqlClient = yield* SqlClient.SqlClient
          let processCheckpoint = {
            id: processB[0]!.id,
            updatedAt: processB[0]!.updatedAt,
          }
          for (const id of ["prc-checkpoint-b", "prc-checkpoint-a"]) {
            yield* sqlClient.withTransaction(
              processes.advanceProcessRevision(id),
            )
            const changed = yield* processes.pullProcess(processCheckpoint, 1)
            expect(changed.map((row) => row.id)).toEqual([id])
            expect(Number(changed[0]!.updatedAt)).toBeGreaterThan(
              Number(processCheckpoint.updatedAt),
            )
            processCheckpoint = { id, updatedAt: changed[0]!.updatedAt }
          }
          expect(yield* processes.pullProcess(processCheckpoint, 1)).toEqual([])

          const executions = yield* ExecutionQueries
          const executionA = yield* executions.pullExecution(null, 1)
          const executionB = yield* executions.pullExecution(
            { id: executionA[0]!.id, updatedAt: executionA[0]!.updatedAt },
            1,
          )
          expect(executionA.map(({ id }) => id)).toEqual(["pex-checkpoint-a"])
          expect(executionB.map(({ id }) => id)).toEqual(["pex-checkpoint-b"])
          expect(
            yield* executions.pullExecution(
              { id: executionB[0]!.id, updatedAt: executionB[0]!.updatedAt },
              1,
            ),
          ).toEqual([])

          const expectedLiveTodoIds = [
            "todo-checkpoint-a",
            "todo-checkpoint-b",
            ...extraLiveTodoIds,
          ]
          const replicationHead = yield* todos.getTodoReplicationHead()
          expect(replicationHead).toEqual({
            id: "todo-checkpoint-deleted-head",
            updatedAt: replicationHeadMillis,
          })
          const firstTodoPage = yield* todos.pullTodo(null, 50, {
            kind: "live-backfill",
            head: replicationHead,
          })
          expect(firstTodoPage.map(({ id }) => id)).toEqual(
            expectedLiveTodoIds.slice(0, 50),
          )
          expect(firstTodoPage.every(({ deleted }) => !deleted)).toBe(true)

          const firstTodoCheckpoint = firstTodoPage[49]!
          expect(
            yield* todos.pullTodo(null, 100, {
              kind: "live-backfill",
              head: {
                id: firstTodoCheckpoint.id,
                updatedAt: firstTodoCheckpoint.updatedAt,
              },
            }),
          ).toEqual(firstTodoPage)
          expect(
            yield* todos.pullTodo(null, 100, {
              kind: "live-backfill",
              head: null,
            }),
          ).toEqual([])

          const finalTodoPage = yield* todos.pullTodo(
            {
              id: firstTodoCheckpoint.id,
              updatedAt: firstTodoCheckpoint.updatedAt,
            },
            50,
            { kind: "live-backfill", head: replicationHead },
          )
          expect(finalTodoPage.map(({ id }) => id)).toEqual(
            expectedLiveTodoIds.slice(50),
          )
          expect(finalTodoPage.every(({ deleted }) => !deleted)).toBe(true)

          const finalLiveTodo = finalTodoPage[0]!
          expect(
            yield* todos.pullTodo(
              { id: finalLiveTodo.id, updatedAt: finalLiveTodo.updatedAt },
              50,
              { kind: "live-backfill", head: replicationHead },
            ),
          ).toEqual([])

          expect(
            yield* todos.pullTodo(replicationHead, 50, {
              kind: "incremental",
            }),
          ).toEqual([])

          const db = yield* TypedPostgresDrizzle
          yield* db
            .update(schema.toDo)
            .set({ _deleted: true, updatedAt: completionTimestamp })
            .where(eq(schema.toDo.id, finalLiveTodo.id))

          const incrementalPage = yield* todos.pullTodo(replicationHead, 50, {
            kind: "incremental",
          })
          expect(incrementalPage).toHaveLength(1)
          expect(incrementalPage[0]).toMatchObject({
            id: finalLiveTodo.id,
            deleted: true,
            updatedAt: completionMillis,
          })

          const missingCheckpointPage = yield* todos.pullTodo(
            {
              id: "todo-checkpoint-missing",
              updatedAt: incrementalStartMillis,
            },
            50,
            { kind: "incremental" },
          )
          expect(missingCheckpointPage.map(({ id }) => id)).toEqual([
            "todo-checkpoint-deleted-head",
            finalLiveTodo.id,
          ])
        }),
    )
  },
)

it.layer(TestLayer)("execution history window", (it) => {
  it.effect(
    "includes old Running executions and pages past them without syncing old terminal history",
    () =>
      Effect.gen(function* () {
        yield* seedCollections
        const db = yield* TypedPostgresDrizzle
        const executions = yield* ExecutionQueries
        const historySince = Date.parse("2026-09-01T00:00:00Z")
        const recentTimestamp = sql`TIMESTAMPTZ '2026-09-02T00:00:00Z'`
        for (const kind of ["completed", "failed", "abandoned", "recent"]) {
          const stateId = `pst-history-${kind}`
          yield* db.insert(schema.processState).values({
            id: stateId,
            processId: "prc-checkpoint-a",
            startStepId: "step-checkpoint-start-a",
            state: {},
          })
          yield* db.insert(schema.processExecution).values({
            id: `pex-history-${kind}`,
            processStateId: stateId,
            updatedAt:
              kind === "recent" ? recentTimestamp : checkpointTimestamp,
            finishedAt:
              kind === "completed" || kind === "recent" ? timestamp : null,
            abandonedReason: kind === "failed" ? "Failure" : null,
            abandonedAt: kind === "abandoned" ? timestamp : null,
          })
        }
        const first = yield* executions.pullExecution(
          { id: "", updatedAt: historySince },
          1,
          true,
          historySince,
        )
        expect(first.map(({ id }) => id)).toEqual(["pex-checkpoint-a"])
        const second = yield* executions.pullExecution(
          { id: first[0]!.id, updatedAt: first[0]!.updatedAt },
          1,
          false,
          historySince,
        )
        expect(second.map(({ id }) => id)).toEqual(["pex-checkpoint-b"])
        const third = yield* executions.pullExecution(
          { id: second[0]!.id, updatedAt: second[0]!.updatedAt },
          1,
          false,
          historySince,
        )
        expect(third.map(({ id }) => id)).toEqual(["pex-history-recent"])
        const head = { id: third[0]!.id, updatedAt: third[0]!.updatedAt }
        expect(
          yield* executions.pullExecution(head, 1, false, historySince),
        ).toEqual([])
        const initial = yield* executions.pullExecution(
          { id: "", updatedAt: historySince },
          50,
          true,
          historySince,
        )
        expect(initial.map(({ id }) => id)).toEqual([
          "pex-checkpoint-a",
          "pex-checkpoint-b",
          "pex-history-recent",
        ])
        yield* db
          .update(schema.processExecution)
          .set({
            finishedAt: timestamp,
            updatedAt: DateTime.makeUnsafe("2026-09-03T00:00:00Z"),
          })
          .where(eq(schema.processExecution.id, "pex-checkpoint-a"))
        const completion = yield* executions.pullExecution(
          head,
          50,
          false,
          historySince,
        )
        expect(
          completion.find(({ id }) => id === "pex-checkpoint-a")?.status,
        ).toBe("Completed")
      }),
  )
})

it.layer(TestLayer, { timeout: "60 seconds" })(
  "concurrent Process revisions",
  (it) => {
    it.effect(
      "pulls a lower-ID event committed after another event or import",
      () =>
        Effect.gen(function* () {
          yield* seedCollections
          const client = yield* SqlClient.SqlClient
          const processes = yield* ProcessCollectionQueries
          const imports = yield* DbOperations
          for (const firstWriter of ["event", "import"]) {
            const firstReady = yield* Deferred.make<void>()
            const commitFirst = yield* Deferred.make<void>()
            const secondReady = yield* Deferred.make<void>()
            const commitSecond = yield* Deferred.make<void>()
            const first = yield* Effect.forkScoped(
              client.withTransaction(
                Effect.gen(function* () {
                  if (firstWriter === "event") {
                    yield* processes.advanceProcessRevision("prc-checkpoint-b")
                  } else {
                    const revision =
                      yield* imports.nextProcessReplicationRevision
                    yield* imports.setProcessReplicationRevision(revision)
                  }
                  yield* Deferred.succeed(firstReady, undefined)
                  yield* Deferred.await(commitFirst)
                }),
              ),
            )
            yield* Deferred.await(firstReady).pipe(
              Effect.raceFirst(Fiber.join(first)),
            )
            const second = yield* Effect.forkScoped(
              client.withTransaction(
                Effect.gen(function* () {
                  yield* client`SET LOCAL application_name = 'process-revision-regression'`
                  yield* processes.advanceProcessRevision("prc-checkpoint-a")
                  yield* Deferred.succeed(secondReady, undefined)
                  yield* Deferred.await(commitSecond)
                }),
              ),
            )
            // Wait for the actual concurrent allocation: it either finishes (the
            // regression) or blocks behind the first writer. No timing assumptions.
            while (!(yield* Deferred.isDone(secondReady))) {
              const waiting = yield* client`
            SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database()
              AND application_name = 'process-revision-regression'
              AND wait_event_type = 'Lock'`
              if (waiting.length > 0) break
              yield* Effect.yieldNow
            }
            yield* Deferred.succeed(commitFirst, undefined)
            yield* Fiber.join(first)
            const page = yield* processes.pullProcess(null, 50)
            const head = page.at(-1)!
            expect(head.id).toBe("prc-checkpoint-b")
            yield* Deferred.await(secondReady).pipe(
              Effect.raceFirst(Fiber.join(second)),
            )
            yield* Deferred.succeed(commitSecond, undefined)
            yield* Fiber.join(second)
            const changed = yield* processes.pullProcess(
              { id: head.id, updatedAt: head.updatedAt },
              50,
            )
            expect(changed.map(({ id }) => id)).toEqual(["prc-checkpoint-a"])
            expect(Number(changed[0]!.updatedAt)).toBeGreaterThan(
              Number(head.updatedAt),
            )
          }
        }).pipe(Effect.scoped),
    )
  },
)
