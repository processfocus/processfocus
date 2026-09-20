import { SqlClient } from "@effect/sql"
import type { Job } from "@processfocus/runtime"
import { Effect, Schema } from "effect"
import {
  CompletedJobOperations,
  TODO_EVENT_QUEUE,
  TodoQueries,
} from "@pf/graphql-db-operations"
import { TodoSummaryComputation } from "@pf/todo-summary"
import { TodoFromJobPublisher } from "../services/todo-from-job-publisher"

// Re-export for backward compatibility
export { TODO_EVENT_QUEUE }

/**
 * Schema for todo-event queue job payloads.
 */
export const TodoEventPayloadSchema = Schema.Struct({
  todoIds: Schema.Array(Schema.String),
})

export type TodoEventPayload = typeof TodoEventPayloadSchema.Type

/**
 * Handler for todo-event queue jobs.
 *
 * This handler is responsible for fetching todo data and publishing events
 * after todos are created by the flow-execution handler. This decouples
 * event publishing from the flow execution transaction.
 *
 * Idempotency:
 * - Uses completed_job table to track which jobs have been processed
 * - If job was already completed, skips processing
 *
 * Error handling:
 * - If todos don't exist (flow-execution rolled back), logs warning and exits
 * - If publishing fails, no completion marker is written and the job retries
 */
const handleTodoEvent = Effect.fn("todo-event")((job: Job<TodoEventPayload>) =>
  Effect.gen(function* () {
    const { todoIds } = job.payload
    const completedJobOps = yield* CompletedJobOperations
    const todoQueries = yield* TodoQueries
    const todoPublisher = yield* TodoFromJobPublisher

    // Idempotency check - if already completed, exit early
    const alreadyCompleted = yield* completedJobOps.isJobCompleted(
      TODO_EVENT_QUEUE,
      job.jobId,
    )
    if (alreadyCompleted) {
      yield* Effect.log("Job already completed, skipping", {
        jobId: job.jobId,
        todoIds,
      })
      return
    }

    yield* Effect.log("Processing todo-event job", {
      jobId: job.jobId,
      todoCount: todoIds.length,
    })

    const sqlClient = yield* SqlClient.SqlClient

    // Keep the database snapshot short; publication must not hold its writer.
    const todosWithSummary = yield* sqlClient.withTransaction(
      Effect.gen(function* () {
        // Fetch todos from database
        const todos = yield* todoQueries.getTodos(todoIds)

        // Handle case where todos don't exist (flow-execution rolled back)
        if (todos.length === 0) {
          yield* Effect.logWarning(
            "No todos found for IDs - flow-execution may have rolled back",
            { todoIds },
          )
          return []
        }

        // Log if some todos are missing (partial rollback or data issue)
        if (todos.length !== todoIds.length) {
          yield* Effect.logWarning(
            "Some todos not found - possible partial rollback",
            {
              expectedCount: todoIds.length,
              foundCount: todos.length,
              todoIds,
            },
          )
        }

        // Compute summaries for todos before publishing
        const summaryComputation = yield* TodoSummaryComputation
        return yield* summaryComputation.enrichWithSummaries(todos)
      }),
    )

    // The producer may still be acknowledging its outbox during publication.
    if (todosWithSummary.length > 0) {
      yield* todoPublisher.publishTodosCreated(todosWithSummary)
      yield* Effect.log("Published todo changed events", {
        count: todosWithSummary.length,
      })
    }

    // A failure here can redeliver the event; delivery is at least once.
    yield* sqlClient.withTransaction(
      completedJobOps.markJobCompleted(TODO_EVENT_QUEUE, job.jobId),
    )
  }),
)

export const todoEventHandler = {
  schema: TodoEventPayloadSchema,
  handle: handleTodoEvent,
}
