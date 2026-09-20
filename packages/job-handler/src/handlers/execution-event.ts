import { SqlClient } from "@effect/sql"
import type { Job } from "@processfocus/runtime"
import { Effect, Schema } from "effect"
import {
  CompletedJobOperations,
  EXECUTION_EVENT_QUEUE,
} from "@pf/graphql-db-operations"
import { ExecutionFromJobPublisher } from "../services/execution-from-job-publisher"

// Re-export for backward compatibility
export { EXECUTION_EVENT_QUEUE }

/**
 * Schema for execution-event queue job payloads.
 */
export const ExecutionEventPayloadSchema = Schema.Struct({
  executionId: Schema.String,
})

export type ExecutionEventPayload = typeof ExecutionEventPayloadSchema.Type

/**
 * Handler for execution-event queue jobs.
 *
 * This handler is responsible for publishing execution changed events
 * after execution state changes. This decouples event publishing from
 * the flow execution transaction.
 *
 * Idempotency:
 * - Uses completed_job table to track which jobs have been processed
 * - If job was already completed, skips processing
 *
 * Error handling:
 * - If the execution is missing (flow-execution rolled back), logs a warning,
 *   marks the job completed, and exits without treating it as a failure
 * - If publishing fails, no completion marker is written and the job retries
 */
const handleExecutionEvent = Effect.fn("execution-event")(
  (job: Job<ExecutionEventPayload>) =>
    Effect.gen(function* () {
      const { executionId } = job.payload
      const completedJobOps = yield* CompletedJobOperations
      const executionPublisher = yield* ExecutionFromJobPublisher

      // Idempotency check - if already completed, exit early
      const alreadyCompleted = yield* completedJobOps.isJobCompleted(
        EXECUTION_EVENT_QUEUE,
        job.jobId,
      )
      if (alreadyCompleted) {
        yield* Effect.log("Job already completed, skipping", {
          jobId: job.jobId,
          executionId,
        })
        return
      }

      yield* Effect.log("Processing execution-event job", {
        jobId: job.jobId,
        executionId,
      })

      const sqlClient = yield* SqlClient.SqlClient

      // External publication cannot be rolled back. Do not hold the DB writer
      // while publishing: the producer may still be acknowledging its outbox.
      const outcome =
        yield* executionPublisher.publishExecutionChanged(executionId)
      if (outcome === "skipped-not-found") {
        yield* Effect.logWarning(
          "No execution found for ID - flow-execution may have rolled back",
          { executionId },
        )
      } else {
        yield* Effect.log("Published execution changed event", { executionId })
      }

      // A failure here can redeliver the event; delivery is at least once.
      yield* sqlClient.withTransaction(
        completedJobOps.markJobCompleted(EXECUTION_EVENT_QUEUE, job.jobId),
      )
    }),
)

export const executionEventHandler = {
  schema: ExecutionEventPayloadSchema,
  handle: handleExecutionEvent,
}
