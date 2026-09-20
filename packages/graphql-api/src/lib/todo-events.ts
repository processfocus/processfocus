import { Context, Data, type Effect } from "effect"
import type { GraphQLSchema } from "graphql"
import type { TodoPullBulk } from "@pf/graphql-schema"

/**
 * Event emitted when todos change.
 * Contains the changed documents and checkpoint for efficient streaming.
 */
export type TodoChangeEvent = TodoPullBulk

/**
 * Error thrown when subscriptions are not supported in the current runtime
 */
class SubscriptionNotSupportedError extends Data.TaggedError(
  "SubscriptionNotSupportedError",
)<{
  readonly message: string
}> {}

/**
 * Service for broadcasting todo changes to WebSocket subscribers
 */
export class TodoEvents extends Context.Tag("@pf/graphql-api/TodoEvents")<
  TodoEvents,
  {
    /**
     * Emit a change event to all active subscribers.
     *
     * Unlike process/execution event services (best-effort fanout), todo emit
     * surfaces failures so job-worker publishers can retry via
     * `TodoFromJobPublishError`. Local in-memory hubs never fail in practice.
     *
     * The error channel is `unknown` on purpose: implementations may fail with
     * AppSync, registry, serialization, or auth errors that are not unified
     * under a shared tagged type. Callers must map failures at the boundary
     * (as `AppSyncTodoFromJobPublisher` does) rather than pattern-matching on E.
     *
     * @param event The change event containing documents and checkpoint
     * @param schema The GraphQL schema for serializing custom scalars
     *
     * Implementations close over runtime dependencies (auth, AppSync, etc.)
     * when the service layer is constructed, so emit has no remaining requirements.
     */
    readonly emit: (
      event: TodoChangeEvent,
      schema: GraphQLSchema,
    ) => Effect.Effect<void, unknown, never>

    /**
     * Subscribe to change events
     * Returns an async iterable that yields events as they occur
     * May fail with SubscriptionNotSupportedError in runtimes that don't support subscriptions
     */
    readonly subscribe: () => Effect.Effect<
      AsyncIterable<TodoChangeEvent>,
      SubscriptionNotSupportedError
    >
  }
>() {}
