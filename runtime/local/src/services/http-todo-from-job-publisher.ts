import { HttpClient } from "@effect/platform"
import { Config, Effect, Layer } from "effect"
import type { TodoRow } from "@pf/graphql-db-operations"
import {
  TodoFromJobPublishError,
  TodoFromJobPublisher,
  buildTodoChangeEvent,
} from "@pf/job-handler"
import { GraphqlServerUrl } from "./graphql-server-config"
import { postInternalEvent } from "./post-internal-event"

/**
 * TodoFromJobPublisher implementation for local runtime.
 * Publishes todo creation events via HTTP POST to the GraphQL server's internal endpoint.
 * Uses fire-and-forget pattern since the local runtime keeps running.
 */
export const HttpTodoFromJobPublisherLive = Layer.effect(
  TodoFromJobPublisher,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient
    const callbackSecret = yield* Config.option(
      Config.string("INTERNAL_API_SECRET"),
    )
    const baseUrl = yield* GraphqlServerUrl

    return {
      publishTodosCreated: (todos: readonly TodoRow[]) =>
        Effect.gen(function* () {
          const event = buildTodoChangeEvent(todos)
          if (!event) {
            return
          }

          const todoIds = todos.map((t) => t.id)

          yield* postInternalEvent(
            httpClient,
            baseUrl,
            "/internal/todo-event",
            event,
            callbackSecret,
            (cause) =>
              new TodoFromJobPublishError({
                todoIds,
                cause,
              }),
          )
        }),
    }
  }),
)
