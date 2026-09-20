import { Context, Data, type Effect } from "effect"
import type { TodoRow } from "@pf/graphql-db-operations"

/**
 * Error thrown when publishing a todo event fails.
 */
export class TodoFromJobPublishError extends Data.TaggedError(
  "TodoFromJobPublishError",
)<{
  readonly todoIds: readonly string[]
  readonly cause?: unknown
}> {}

/**
 * Service for publishing todo creation events from job handlers.
 *
 * This is the abstraction used by job handlers to notify about new todos.
 * Implementations differ by runtime:
 * - AWS: Delegates to TodoEvents which publishes to AppSync with Cedar auth;
 *   emit failures are mapped to `TodoFromJobPublishError` for job retry
 * - Local: HTTP POST to the GraphQL server's internal endpoint; transport
 *   failures are mapped to `TodoFromJobPublishError`
 */
export class TodoFromJobPublisher extends Context.Tag(
  "@pf/job-handler/TodoFromJobPublisher",
)<
  TodoFromJobPublisher,
  {
    /**
     * Publish todo creation events for a batch of todos.
     * Emits a single event containing all todos.
     * The implementation determines how this reaches the TodoEvents service.
     *
     * Implementations close over runtime dependencies when the service layer
     * is constructed, so the method effect has no remaining requirements.
     */
    readonly publishTodosCreated: (
      todos: readonly TodoRow[],
    ) => Effect.Effect<void, TodoFromJobPublishError, never>
  }
>() {}
