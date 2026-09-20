import { SqlClient } from "@effect/sql"
import type { Job } from "@processfocus/runtime"
import { Effect, Schema } from "effect"
import {
  CompletedJobOperations,
  PROCESS_EVENT_QUEUE,
} from "@pf/graphql-db-operations"
import { ProcessFromJobPublisher } from "../services/process-from-job-publisher"

// Re-export for backward compatibility
export { PROCESS_EVENT_QUEUE }

/**
 * Schema for process-event queue job payloads.
 */
export const ProcessEventPayloadSchema = Schema.Struct({
  processId: Schema.String,
})

export type ProcessEventPayload = typeof ProcessEventPayloadSchema.Type

/**
 * Handler for process-event queue jobs.
 *
 * This handler is responsible for publishing process changed events
 * after process state changes. This decouples event publishing from
 * the flow execution transaction.
 *
 * Idempotency:
 * - Uses completed_job table to track which jobs have been processed
 * - If job was already completed, skips processing
 *
 * Error handling:
 * - If the process is missing (flow-execution rolled back), logs a warning,
 *   marks the job completed, and exits without treating it as a failure
 * - If publishing fails, no completion marker is written and the job retries
 */
const handleProcessEvent = Effect.fn("process-event")(
  (job: Job<ProcessEventPayload>) =>
    Effect.gen(function* () {
      const { processId } = job.payload
      const completedJobOps = yield* CompletedJobOperations
      const processPublisher = yield* ProcessFromJobPublisher

      // Idempotency check - if already completed, exit early
      const alreadyCompleted = yield* completedJobOps.isJobCompleted(
        PROCESS_EVENT_QUEUE,
        job.jobId,
      )
      if (alreadyCompleted) {
        yield* Effect.log("Job already completed, skipping", {
          jobId: job.jobId,
          processId,
        })
        return
      }

      yield* Effect.log("Processing process-event job", {
        jobId: job.jobId,
        processId,
      })

      const sqlClient = yield* SqlClient.SqlClient

      // External publication cannot be rolled back. Do not hold the DB writer
      // while publishing: the producer may still be acknowledging its outbox.
      const outcome = yield* processPublisher.publishProcessChanged(processId)
      if (outcome === "skipped-not-found") {
        yield* Effect.logWarning(
          "No process found for ID - flow-execution may have rolled back",
          { processId },
        )
      } else {
        yield* Effect.log("Published process changed event", { processId })
      }

      // A failure here can redeliver the event; delivery is at least once.
      yield* sqlClient.withTransaction(
        completedJobOps.markJobCompleted(PROCESS_EVENT_QUEUE, job.jobId),
      )
    }),
)

export const processEventHandler = {
  schema: ProcessEventPayloadSchema,
  handle: handleProcessEvent,
}
