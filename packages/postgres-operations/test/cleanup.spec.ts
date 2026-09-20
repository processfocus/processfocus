import { expect, it } from "@effect/vitest"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import * as schema from "@pf/drizzle-postgres"
import { CleanupOperations } from "@pf/graphql-db-operations"
import { PostgresCleanupOperationsLive } from "../src/lib/cleanup"
import { PostgresTest, TypedPostgresDrizzle } from "./postgres-test"

const TestLayer = Layer.provideMerge(
  PostgresCleanupOperationsLive,
  PostgresTest,
)

it.layer(TestLayer, { timeout: "60 seconds" })("cleanup operations", (it) => {
  it.effect("deletes public completion invitation attempts before todos", () =>
    Effect.gen(function* () {
      const db = yield* TypedPostgresDrizzle
      const suffix = Date.now().toString(36)
      const orgUnitId = `ou-cleanup-${suffix}`
      const processId = `prc-cleanup-${suffix}`
      const startStepId = `step-start-cleanup-${suffix}`
      const completeStepId = `step-complete-cleanup-${suffix}`
      const flowId = `flow-cleanup-${suffix}`
      const processStateId = `pst-cleanup-${suffix}`
      const processExecutionId = `pex-cleanup-${suffix}`
      const todoId = `todo-cleanup-${suffix}`
      const attemptId = `pcia-cleanup-${suffix}`

      yield* db.insert(schema.orgUnit).values({
        id: orgUnitId,
        name: "Ops",
        orgUnitLevel: "department",
        path: `ops-cleanup-${suffix}`,
        timezone: "UTC",
      })
      yield* db.insert(schema.process).values({
        id: processId,
        orgUnitId,
        name: "Cleanup process",
        path: `ops-cleanup-${suffix}/cleanup`,
        purpose: "Test cleanup ordering",
      })
      yield* db.insert(schema.step).values({
        id: startStepId,
        name: "Start",
        path: `/ops-cleanup-${suffix}/cleanup/Start`,
        purpose: "Start cleanup test",
        processId,
      })
      yield* db.insert(schema.step).values({
        id: completeStepId,
        name: "Complete",
        path: `/ops-cleanup-${suffix}/cleanup/Complete`,
        purpose: "Complete cleanup test",
        processId,
      })
      yield* db.insert(schema.flow).values({
        id: flowId,
        flowKey: `flow-cleanup-${suffix}`,
        sourceStepId: startStepId,
        targetStepId: completeStepId,
      })
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId,
        startStepId,
        state: {},
      })
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
      })
      yield* db.insert(schema.toDo).values({
        id: todoId,
        processExecutionId,
        flowId,
      })
      yield* db.insert(schema.publicCompletionInvitationAttempt).values({
        id: attemptId,
        toDoId: todoId,
        email: "external@example.com",
      })

      const cleanupOps = yield* CleanupOperations
      const result = yield* cleanupOps.cleanupExecutions()

      expect(result.todosDeleted).toBe(1)
      expect(
        yield* db
          .select()
          .from(schema.publicCompletionInvitationAttempt)
          .where(eq(schema.publicCompletionInvitationAttempt.id, attemptId)),
      ).toEqual([])
      expect(
        yield* db.select().from(schema.toDo).where(eq(schema.toDo.id, todoId)),
      ).toEqual([])
    }),
  )
})
