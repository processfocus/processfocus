import { Context, Data, type Effect } from "effect"
import type { GraphQLSchema } from "graphql"
import type { DraftProcessExecutionRow } from "@pf/graphql-db-operations"
import type {
  DraftProcessExecution,
  DraftProcessExecutionPullBulk,
} from "@pf/graphql-schema"

export type DraftProcessExecutionEventDocument = DraftProcessExecution &
  Pick<DraftProcessExecutionRow, "startedByEmail" | "startedByUserId">

/**
 * Event emitted when draft process executions change.
 * Contains the changed documents and checkpoint for efficient streaming.
 */
export type DraftProcessChangeEvent = Omit<
  DraftProcessExecutionPullBulk,
  "documents"
> & {
  documents: DraftProcessExecutionEventDocument[]
}

/**
 * Error thrown when subscriptions are not supported in the current runtime
 */
export class SubscriptionNotSupportedError extends Data.TaggedError(
  "SubscriptionNotSupportedError",
)<{
  readonly message: string
}> {}

/**
 * Service for broadcasting draft process execution changes to WebSocket subscribers
 */
export class DraftProcessEvents extends Context.Tag(
  "@pf/graphql-api/DraftProcessEvents",
)<
  DraftProcessEvents,
  {
    /**
     * Emit a change event to all active subscribers
     * @param event The change event containing documents and checkpoint
     * @param schema The GraphQL schema for serializing custom scalars
     *
     * Implementations close over runtime dependencies when the service layer is
     * constructed, so emit has no remaining requirements.
     */
    readonly emit: (
      event: DraftProcessChangeEvent,
      schema: GraphQLSchema,
    ) => Effect.Effect<void, never, never>

    /**
     * Subscribe to change events
     * Returns an async iterable that yields events as they occur
     * May fail with SubscriptionNotSupportedError in runtimes that don't support subscriptions
     */
    readonly subscribe: () => Effect.Effect<
      AsyncIterable<DraftProcessChangeEvent>,
      SubscriptionNotSupportedError
    >
  }
>() {}
