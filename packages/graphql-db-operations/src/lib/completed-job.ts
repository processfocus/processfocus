import type { SqlError } from "@effect/sql/SqlError"
import { Context, type Effect } from "effect"
import type { RequestTime } from "@pf/request-time"
import type { UserDetails } from "./user-details"

export const getStartedSystemStepCompletedJobId = (executionId: string) =>
  `start-${executionId}`

/**
 * Service providing completed job database operations for idempotency.
 *
 * The completed_job table tracks which jobs have been successfully processed.
 * This enables crash-safe job handling:
 * 1. At the start of job processing, check if the job was already completed
 * 2. If already completed, skip processing (idempotent retry)
 * 3. At the end of successful processing, mark the job as completed (inside transaction)
 *
 * This pattern handles the case where a job commits successfully but the worker
 * crashes before acknowledging the job to the queue.
 */
export class CompletedJobOperations extends Context.Tag(
  "@pf/graphql-db-operations/CompletedJobOperations",
)<
  CompletedJobOperations,
  {
    /**
     * Check if a job has already been completed.
     * Call this at the start of job processing to implement idempotency.
     */
    readonly isJobCompleted: (
      queue: string,
      jobId: string,
    ) => Effect.Effect<boolean, SqlError>

    /**
     * Mark a job as completed.
     * Call this inside the transaction at the end of successful job processing.
     */
    readonly markJobCompleted: (
      queue: string,
      jobId: string,
    ) => Effect.Effect<void, SqlError>

    /**
     * Soft-delete a completed-job marker so the same logical job can run again
     * (for example after restarting a failed system-start execution).
     */
    readonly clearJobCompleted: (
      queue: string,
      jobId: string,
    ) => Effect.Effect<void, SqlError, RequestTime | UserDetails>
  }
>() {}
