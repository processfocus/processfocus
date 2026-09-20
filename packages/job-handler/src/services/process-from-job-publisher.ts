import { Context, Data, type Effect } from "effect"
import type { FromJobPublishOutcome } from "./from-job-publish-outcome"

export type { FromJobPublishOutcome } from "./from-job-publish-outcome"

/**
 * Error thrown when publishing a process event fails.
 */
export class ProcessFromJobPublishError extends Data.TaggedError(
  "ProcessFromJobPublishError",
)<{
  readonly processId: string
  readonly cause?: unknown
}> {}

/**
 * Service for publishing process change events from job handlers.
 *
 * This is the abstraction used by job handlers to notify about process changes.
 * Implementations differ by runtime:
 * - AWS: Delegates to ProcessEvents which publishes to AppSync with Cedar auth
 * - Local: HTTP POST to GraphQL server (fire-and-forget)
 */
export class ProcessFromJobPublisher extends Context.Tag(
  "@pf/job-handler/ProcessFromJobPublisher",
)<
  ProcessFromJobPublisher,
  {
    /**
     * Publish a process changed event.
     * Called when activeInstances changes (execution starts/finishes).
     *
     * Returns `"published"` when the event was sent, or `"skipped-not-found"`
     * when the process is missing (e.g. flow-execution rolled back). A miss
     * is an expected race, not a failure.
     *
     * Implementations close over runtime dependencies when the service layer
     * is constructed, so the method effect has no remaining requirements.
     */
    readonly publishProcessChanged: (
      processId: string,
    ) => Effect.Effect<FromJobPublishOutcome, ProcessFromJobPublishError, never>
  }
>() {}
