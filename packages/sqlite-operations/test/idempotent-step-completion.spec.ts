import { eq } from "drizzle-orm"
import { DateTime, Effect, FiberRef, Layer } from "effect"
import * as schema from "@pf/drizzle-sqlite"
import {
  ScheduledFlowOperations,
  StepCompletionOperations,
  UserDetails,
  type UserDetailsValue,
} from "@pf/graphql-db-operations"
import { RequestTime } from "@pf/request-time"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"
import { DatabaseTest } from "@pf/service-drizzle-sqlite/test"
import { SqliteScheduledFlowOperationsLive } from "../src/lib/scheduled-flow"
import { SqliteStepCompletionOperationsLive } from "../src/lib/step-completion"
import { describe, expect, it } from "bun:test"

const originalTime = DateTime.unsafeMake("2026-08-08T08:00:00.000Z")
const requestTime = DateTime.unsafeMake("2026-08-08T09:00:00.000Z")

const TestLayer = Layer.provideMerge(
  Layer.mergeAll(
    SqliteStepCompletionOperationsLive,
    SqliteScheduledFlowOperationsLive,
    Layer.succeed(RequestTime, FiberRef.unsafeMake(requestTime)),
    Layer.succeed(
      UserDetails,
      FiberRef.unsafeMake<UserDetailsValue>({
        by: "completion-test@example.com",
        id: "completion-test@example.com",
      }),
    ),
  ),
  DatabaseTest,
)

const seedCompletion = (suffix: string) =>
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle
    const ids = {
      orgUnit: `org-${suffix}`,
      process: `process-${suffix}`,
      role: `role-${suffix}`,
      sourceStep: `source-${suffix}`,
      targetStep: `target-${suffix}`,
      flow: `flow-${suffix}`,
      processState: `state-${suffix}`,
      execution: `execution-${suffix}`,
      todo: `todo-${suffix}`,
    }

    yield* db.insert(schema.orgUnit).values({
      id: ids.orgUnit,
      name: `Organisation ${suffix}`,
      orgUnitLevel: "organisation",
      path: `organisation-${suffix}`,
    })
    yield* db.insert(schema.process).values({
      id: ids.process,
      name: `Process ${suffix}`,
      orgUnitId: ids.orgUnit,
      path: `organisation-${suffix}/process`,
      purpose: "Exercise replay-safe completion operations",
    })
    yield* db.insert(schema.role).values({
      id: ids.role,
      name: `Role ${suffix}`,
      orgUnitId: ids.orgUnit,
      path: `organisation-${suffix}/role`,
    })
    yield* db.insert(schema.step).values([
      {
        id: ids.sourceStep,
        name: `Source ${suffix}`,
        path: `organisation-${suffix}/process/source`,
        purpose: "Source",
        processId: ids.process,
        roleId: ids.role,
      },
      {
        id: ids.targetStep,
        name: `Target ${suffix}`,
        path: `organisation-${suffix}/process/target`,
        purpose: "Target",
        processId: ids.process,
        roleId: ids.role,
      },
    ])
    yield* db.insert(schema.flow).values({
      id: ids.flow,
      flowKey: `flow-key-${suffix}`,
      sourceStepId: ids.sourceStep,
      targetStepId: ids.targetStep,
    })
    yield* db.insert(schema.processState).values({
      id: ids.processState,
      processId: ids.process,
      startStepId: ids.sourceStep,
      state: { nested: { first: true } },
      createdAt: originalTime,
      updatedAt: originalTime,
    })
    yield* db.insert(schema.processExecution).values({
      id: ids.execution,
      processStateId: ids.processState,
      createdAt: originalTime,
      updatedAt: originalTime,
    })
    yield* db.insert(schema.toDo).values({
      id: ids.todo,
      processExecutionId: ids.execution,
      flowId: ids.flow,
      createdAt: originalTime,
      updatedAt: originalTime,
    })

    return ids
  })

describe("idempotent step completion operations", () => {
  it("applies a process-state patch only when the updatedAt token matches", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle
        const operations = yield* StepCompletionOperations
        const ids = yield* seedCompletion("cas")
        const snapshot = yield* operations.getProcessStateByTodoId(ids.todo)
        if (!snapshot) {
          return yield* Effect.dieMessage("Missing process state snapshot")
        }

        const updated = yield* operations.updateProcessStateIfUnchanged(
          ids.processState,
          snapshot.updatedAt,
          { nested: { second: true } },
        )
        const updatedAgain = yield* operations.updateProcessStateIfUnchanged(
          ids.processState,
          requestTime,
          { nested: { third: true } },
        )
        const conflict = yield* operations.updateProcessStateIfUnchanged(
          ids.processState,
          requestTime,
          { stale: true },
        )
        const rows = yield* db
          .select({
            state: schema.processState.state,
            updatedAt: schema.processState.updatedAt,
          })
          .from(schema.processState)
          .where(eq(schema.processState.id, ids.processState))

        return { conflict, row: rows[0], updated, updatedAgain }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result.updated.kind).toBe("updated")
    expect(result.updatedAgain.kind).toBe("updated")
    expect(result.conflict).toEqual({ kind: "conflict" })
    expect(result.row?.state).toEqual({
      nested: { first: true, second: true, third: true },
    })
    expect(DateTime.toEpochMillis(result.row?.updatedAt ?? originalTime)).toBe(
      DateTime.toEpochMillis(requestTime) + 1,
    )
  })

  it("completes an open todo once and accepts the same outcome on replay", async () => {
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const operations = yield* StepCompletionOperations
        const ids = yield* seedCompletion("todo")
        const input = {
          todoId: ids.todo,
          userId: null,
          businessDurationMs: 15_000,
          externalParticipantId: null,
          completedByRoleId: ids.role,
        }

        const completed = yield* operations.completeToDoIfOpen(input)
        const replayed = yield* operations.completeToDoIfOpen({
          ...input,
          businessDurationMs: 999,
        })
        const conflicting = yield* operations.completeToDoIfOpen({
          ...input,
          completedByRoleId: null,
        })
        return { completed, conflicting, replayed }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(results.completed).toEqual({ kind: "completed" })
    expect(results.replayed).toEqual({ kind: "already-completed" })
    expect(results.conflicting).toEqual({ kind: "conflict" })
  })

  it("appends a process-state item only when the snapshot is current", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle
        const operations = yield* StepCompletionOperations
        const ids = yield* seedCompletion("append-cas")
        const snapshot = yield* operations.getProcessStateByTodoId(ids.todo)
        if (!snapshot) {
          return yield* Effect.dieMessage("Missing process state snapshot")
        }

        const appended =
          yield* operations.appendProcessStateArrayItemIfUnchanged(
            ids.processState,
            snapshot.updatedAt,
            "items",
            { value: 1 },
          )
        const conflict =
          yield* operations.appendProcessStateArrayItemIfUnchanged(
            ids.processState,
            snapshot.updatedAt,
            "items",
            { value: 2 },
          )
        const rows = yield* db
          .select({ state: schema.processState.state })
          .from(schema.processState)
          .where(eq(schema.processState.id, ids.processState))
        return { appended, conflict, state: rows[0]?.state }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result.appended.kind).toBe("updated")
    expect(result.conflict).toEqual({ kind: "conflict" })
    expect(result.state).toEqual({
      items: [{ value: 1 }],
      nested: { first: true },
    })
  })

  it("returns one scheduled flow for duplicate stable-identity inserts", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle
        const operations = yield* ScheduledFlowOperations
        const ids = yield* seedCompletion("scheduled-flow")
        const stableId = "sf-stable-completion-handoff"

        const first = yield* operations.insertOrGetScheduledFlow(
          stableId,
          ids.execution,
          ids.targetStep,
        )
        const second = yield* operations.insertOrGetScheduledFlow(
          stableId,
          ids.execution,
          ids.targetStep,
        )
        const rows = yield* db
          .select({ id: schema.scheduledFlow.id })
          .from(schema.scheduledFlow)
          .where(eq(schema.scheduledFlow.id, stableId))
        return { first, rows, second }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result.first).toBe("sf-stable-completion-handoff")
    expect(result.second).toBe(result.first)
    expect(result.rows).toEqual([{ id: result.first }])
  })
})
