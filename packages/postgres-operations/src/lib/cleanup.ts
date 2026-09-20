import { Effect, Layer } from "effect"
import * as schema from "@pf/drizzle-postgres"
import { CleanupOperations } from "@pf/graphql-db-operations"
import { TypedPostgresDrizzle } from "@pf/service-drizzle-postgres"

/**
 * Live implementation of CleanupOperations service for PostgreSQL.
 *
 * This service provides cleanup operations for e2e test isolation.
 * It hard-deletes all execution-related data (not soft delete) to
 * ensure a clean slate for each test scenario.
 *
 * IMPORTANT: Only use in test environments.
 */
export const PostgresCleanupOperationsLive = Layer.effect(
  CleanupOperations,
  Effect.gen(function* () {
    const db = yield* TypedPostgresDrizzle

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

          // Delete all todos
          const todosResult = yield* db.delete(schema.toDo).returning({
            id: schema.toDo.id,
          })
          const todosDeleted = todosResult.length

          // Delete all scheduled flows
          const scheduledFlowsResult = yield* db
            .delete(schema.scheduledFlow)
            .returning({ id: schema.scheduledFlow.id })
          const scheduledFlowsDeleted = scheduledFlowsResult.length

          // Delete all job queue entries (flow-execution queue)
          const jobsResult = yield* db.delete(schema.jobQueue).returning({
            id: schema.jobQueue.id,
          })
          const jobsDeleted = jobsResult.length

          // Delete all completed job records
          yield* db.delete(schema.completedJob)

          // Delete all process executions
          const executionsResult = yield* db
            .delete(schema.processExecution)
            .returning({ id: schema.processExecution.id })
          const executionsDeleted = executionsResult.length

          // Delete all process states
          const statesResult = yield* db.delete(schema.processState).returning({
            id: schema.processState.id,
          })
          const statesDeleted = statesResult.length

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
