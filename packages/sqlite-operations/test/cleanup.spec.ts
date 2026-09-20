import { Effect, Layer } from "effect"
import * as schema from "@pf/drizzle-sqlite"
import { CleanupOperations } from "@pf/graphql-db-operations"
import {
  DatabaseTest,
  TypedSqliteDrizzle,
} from "@pf/service-drizzle-sqlite/test"
import { SqliteCleanupOperationsLive } from "../src/lib/cleanup"
import { describe, expect, it } from "bun:test"

describe("cleanup operations", () => {
  const TestLayer = Layer.provideMerge(
    SqliteCleanupOperationsLive,
    DatabaseTest,
  )

  type TestRequirements = Layer.Layer.Success<typeof TestLayer>

  const runTest = <A, E>(test: Effect.Effect<A, E, TestRequirements>) =>
    Effect.runPromise(Effect.provide(test, TestLayer))

  it("deletes public completion invitation attempts before todos", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle

        yield* db.insert(schema.orgUnit).values({
          id: "ou-cleanup",
          name: "Ops",
          orgUnitLevel: "department",
          path: "ops",
          timezone: "UTC",
        })
        yield* db.insert(schema.process).values({
          id: "prc-cleanup",
          orgUnitId: "ou-cleanup",
          name: "Cleanup process",
          path: "ops/cleanup",
          purpose: "Test cleanup ordering",
        })
        yield* db.insert(schema.step).values({
          id: "step-start-cleanup",
          name: "Start",
          path: "/ops/cleanup/Start",
          purpose: "Start cleanup test",
          processId: "prc-cleanup",
        })
        yield* db.insert(schema.step).values({
          id: "step-complete-cleanup",
          name: "Complete",
          path: "/ops/cleanup/Complete",
          purpose: "Complete cleanup test",
          processId: "prc-cleanup",
        })
        yield* db.insert(schema.flow).values({
          id: "flow-cleanup",
          flowKey: "flow-cleanup",
          sourceStepId: "step-start-cleanup",
          targetStepId: "step-complete-cleanup",
        })
        yield* db.insert(schema.processState).values({
          id: "pst-cleanup",
          processId: "prc-cleanup",
          startStepId: "step-start-cleanup",
          state: {},
        })
        yield* db.insert(schema.processExecution).values({
          id: "pex-cleanup",
          processStateId: "pst-cleanup",
        })
        yield* db.insert(schema.toDo).values({
          id: "todo-cleanup",
          processExecutionId: "pex-cleanup",
          flowId: "flow-cleanup",
        })
        yield* db.insert(schema.publicCompletionInvitationAttempt).values({
          id: "pcia-cleanup",
          toDoId: "todo-cleanup",
          email: "external@example.com",
        })

        const cleanupOps = yield* CleanupOperations
        const result = yield* cleanupOps.cleanupExecutions()

        expect(result.todosDeleted).toBe(1)
        expect(
          yield* db.select().from(schema.publicCompletionInvitationAttempt),
        ).toEqual([])
        expect(yield* db.select().from(schema.toDo)).toEqual([])
      }),
    ))
})
