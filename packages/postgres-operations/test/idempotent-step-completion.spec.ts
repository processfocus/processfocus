import { expect, it } from "@effect/vitest"
import { eq } from "drizzle-orm"
import { DateTime, Effect, FiberRef, Layer } from "effect"
import * as schema from "@pf/drizzle-postgres"
import {
  ScheduledFlowOperations,
  StepCompletionOperations,
  UserDetails,
  type UserDetailsValue,
} from "@pf/graphql-db-operations"
import { RequestTime } from "@pf/request-time"
import { PostgresScheduledFlowOperationsLive } from "../src/lib/scheduled-flow"
import { PostgresStepCompletionOperationsLive } from "../src/lib/step-completion"
import { PostgresTest, TypedPostgresDrizzle } from "./postgres-test"

const originalTime = DateTime.unsafeMake("2026-08-08T08:00:00.000Z")
const requestTime = DateTime.unsafeMake("2026-08-08T09:00:00.000Z")

const TestLayer = Layer.provideMerge(
  Layer.mergeAll(
    PostgresStepCompletionOperationsLive,
    PostgresScheduledFlowOperationsLive,
    Layer.succeed(RequestTime, FiberRef.unsafeMake(requestTime)),
    Layer.succeed(
      UserDetails,
      FiberRef.unsafeMake<UserDetailsValue>({
        by: "completion-test@example.com",
        id: "completion-test@example.com",
      }),
    ),
  ),
  PostgresTest,
)

const seedCompletion = (suffix: string) =>
  Effect.gen(function* () {
    const db = yield* TypedPostgresDrizzle
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

it.layer(TestLayer, { timeout: "60 seconds" })(
  "idempotent step completion operations",
  (it) => {
    it.effect(
      "applies a process-state patch only when the updatedAt token matches",
      () =>
        Effect.gen(function* () {
          const db = yield* TypedPostgresDrizzle
          const operations = yield* StepCompletionOperations
          const ids = yield* seedCompletion("completion-cas")

          const updated = yield* operations.updateProcessStateIfUnchanged(
            ids.processState,
            originalTime,
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

          expect(updated.kind).toBe("updated")
          expect(updatedAgain.kind).toBe("updated")
          expect(conflict).toEqual({ kind: "conflict" })
          expect(rows[0]?.state).toEqual({
            nested: { first: true, second: true, third: true },
          })
          expect(
            DateTime.toEpochMillis(rows[0]?.updatedAt ?? originalTime),
          ).toBe(DateTime.toEpochMillis(requestTime) + 1)
        }),
    )

    it.effect(
      "completes an open todo once and accepts the same outcome on replay",
      () =>
        Effect.gen(function* () {
          const operations = yield* StepCompletionOperations
          const ids = yield* seedCompletion("completion-todo")
          const input = {
            todoId: ids.todo,
            userId: null,
            businessDurationMs: 15_000,
            externalParticipantId: null,
            completedByRoleId: ids.role,
          }

          expect(yield* operations.completeToDoIfOpen(input)).toEqual({
            kind: "completed",
          })
          expect(
            yield* operations.completeToDoIfOpen({
              ...input,
              businessDurationMs: 999,
            }),
          ).toEqual({ kind: "already-completed" })
          expect(
            yield* operations.completeToDoIfOpen({
              ...input,
              completedByRoleId: null,
            }),
          ).toEqual({ kind: "conflict" })
        }),
    )

    it.effect(
      "returns one scheduled flow for duplicate stable-identity inserts",
      () =>
        Effect.gen(function* () {
          const db = yield* TypedPostgresDrizzle
          const operations = yield* ScheduledFlowOperations
          const ids = yield* seedCompletion("completion-scheduled-flow")
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

          expect(first).toBe(stableId)
          expect(second).toBe(first)
          expect(rows).toEqual([{ id: first }])
        }),
    )

    it.effect(
      "appends a process-state item only when the snapshot is current",
      () =>
        Effect.gen(function* () {
          const db = yield* TypedPostgresDrizzle
          const operations = yield* StepCompletionOperations
          const ids = yield* seedCompletion("completion-append-cas")

          const appended =
            yield* operations.appendProcessStateArrayItemIfUnchanged(
              ids.processState,
              originalTime,
              "items",
              { value: 1 },
            )
          const conflict =
            yield* operations.appendProcessStateArrayItemIfUnchanged(
              ids.processState,
              originalTime,
              "items",
              { value: 2 },
            )
          const rows = yield* db
            .select({ state: schema.processState.state })
            .from(schema.processState)
            .where(eq(schema.processState.id, ids.processState))

          expect(appended.kind).toBe("updated")
          expect(conflict).toEqual({ kind: "conflict" })
          expect(rows[0]?.state).toEqual({
            items: [{ value: 1 }],
            nested: { first: true },
          })
        }),
    )
  },
)
