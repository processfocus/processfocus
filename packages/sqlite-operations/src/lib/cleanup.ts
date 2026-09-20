import { Effect, Layer } from "effect"
import * as schema from "@pf/drizzle-sqlite"
import { CleanupOperations } from "@pf/graphql-db-operations"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"

/**
 * Live implementation of CleanupOperations service for SQLite.
 *
 * This service provides cleanup operations for e2e test isolation.
 * It hard-deletes all execution-related data (not soft delete) to
 * ensure a clean slate for each test scenario.
 *
 * IMPORTANT: Only use in test environments.
 */
export const SqliteCleanupOperationsLive = Layer.effect(
  CleanupOperations,
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle

    return {
      cleanupExecutions: () =>
        Effect.gen(function* () {
          // Delete in order respecting foreign key constraints:
          // 1. public_completion_invitation_attempt (references to_do)
          // 2. to_do (references process_execution)
          // 3. scheduled_flow (references process_execution)
          // 4. job_queue (contains execution-related jobs)
          // 5. completed_job (job completion tracking)
          // 6. process_execution (references process_state)
          // 7. process_state (base of execution data)

          yield* db.delete(schema.publicCompletionInvitationAttempt)

          const todos = yield* db
            .select({ id: schema.toDo.id })
            .from(schema.toDo)
          const todosDeleted = todos.length
          yield* db.delete(schema.toDo)

          const scheduledFlows = yield* db
            .select({ id: schema.scheduledFlow.id })
            .from(schema.scheduledFlow)
          const scheduledFlowsDeleted = scheduledFlows.length
          yield* db.delete(schema.scheduledFlow)

          const jobs = yield* db
            .select({ id: schema.jobQueue.id })
            .from(schema.jobQueue)
          const jobsDeleted = jobs.length
          yield* db.delete(schema.jobQueue)

          // Delete all completed job records
          yield* db.delete(schema.completedJob)

          const executions = yield* db
            .select({ id: schema.processExecution.id })
            .from(schema.processExecution)
          const executionsDeleted = executions.length
          yield* db.delete(schema.processExecution)

          const states = yield* db
            .select({ id: schema.processState.id })
            .from(schema.processState)
          const statesDeleted = states.length
          yield* db.delete(schema.processState)

          yield* Effect.log("Cleanup completed").pipe(
            Effect.annotateLogs({
              todosDeleted,
              scheduledFlowsDeleted,
              executionsDeleted,
              statesDeleted,
              jobsDeleted,
            }),
          )

          return {
            todosDeleted,
            scheduledFlowsDeleted,
            executionsDeleted,
            statesDeleted,
            jobsDeleted,
          }
        }),
    }
  }),
)
