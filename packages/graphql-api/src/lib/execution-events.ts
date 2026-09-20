import { Context, Data, type Effect } from "effect"
import type { GraphQLSchema } from "graphql"
import type { Execution, ExecutionPullBulk } from "@pf/graphql-schema"

/**
 * Event emitted when executions change.
 * Contains the changed documents and checkpoint for efficient streaming.
 */
export interface ExecutionEventDocument extends Execution {
  readonly startedByEmail?: string | null
  readonly startedByRolePath?: string | null
  readonly stepOrgUnitPaths?: readonly string[]
}

export type ExecutionChangeEvent = ExecutionPullBulk

/**
 * Error thrown when subscriptions are not supported in the current runtime
 */
class SubscriptionNotSupportedError extends Data.TaggedError(
  "SubscriptionNotSupportedError",
)<{
  readonly message: string
}> {}

/**
 * Service for broadcasting execution changes to WebSocket subscribers
 */
export class ExecutionEvents extends Context.Tag(
  "@pf/graphql-api/ExecutionEvents",
)<
  ExecutionEvents,
  {
    /**
     * Emit a change event to all active subscribers
     * @param event The change event containing documents and checkpoint
     * @param schema The GraphQL schema for serializing custom scalars
     *
     * Implementations close over runtime dependencies (auth, AppSync, etc.)
     * when the service layer is constructed, so emit has no remaining requirements.
     */
    readonly emit: (
      event: ExecutionChangeEvent,
      schema: GraphQLSchema,
    ) => Effect.Effect<void, never, never>

    /**
     * Subscribe to change events
     * Returns an async iterable that yields events as they occur
     * May fail with SubscriptionNotSupportedError in runtimes that don't support subscriptions
     */
    readonly subscribe: () => Effect.Effect<
      AsyncIterable<ExecutionChangeEvent>,
      SubscriptionNotSupportedError
    >
  }
>() {}
