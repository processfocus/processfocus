import { Context, Data, type Effect } from "effect"
import type { FromJobPublishOutcome } from "./from-job-publish-outcome"

export type { FromJobPublishOutcome } from "./from-job-publish-outcome"

/**
 * Error thrown when publishing an execution event fails.
 */
export class ExecutionFromJobPublishError extends Data.TaggedError(
  "ExecutionFromJobPublishError",
)<{
  readonly executionId: string
  readonly cause?: unknown
}> {}

/**
 * Service for publishing execution change events from job handlers.
 *
 * This is the abstraction used by job handlers to notify about execution changes.
 * Implementations differ by runtime:
 * - AWS: Delegates to ExecutionEvents which publishes to AppSync with Cedar auth
 * - Local: HTTP POST to GraphQL server (fire-and-forget)
 */
export class ExecutionFromJobPublisher extends Context.Tag(
  "@pf/job-handler/ExecutionFromJobPublisher",
)<
  ExecutionFromJobPublisher,
  {
    /**
     * Publish an execution changed event.
     * Called when execution starts, steps complete, or process finishes.
     *
     * Returns `"published"` when the event was sent, or `"skipped-not-found"`
     * when the execution is missing (e.g. flow-execution rolled back). A miss
     * is an expected race, not a failure.
     *
     * Implementations close over runtime dependencies when the service layer
     * is constructed, so the method effect has no remaining requirements.
     */
    readonly publishExecutionChanged: (
      executionId: string,
    ) => Effect.Effect<
      FromJobPublishOutcome,
      ExecutionFromJobPublishError,
      never
    >
  }
>() {}
