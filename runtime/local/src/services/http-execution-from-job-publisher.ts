import { HttpClient } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { Array as Arr, Config, Effect, Layer } from "effect"
import {
  type ExecutionChangeEvent,
  ExecutionCollectionOps,
} from "@pf/graphql-api"
import { UserDetails } from "@pf/graphql-db-operations"
import {
  ExecutionFromJobPublishError,
  ExecutionFromJobPublisher,
} from "@pf/job-handler"
import { GraphqlServerUrl } from "./graphql-server-config"
import { postInternalEvent } from "./post-internal-event"

/**
 * ExecutionFromJobPublisher implementation for local runtime.
 * Publishes execution change events via HTTP POST to the GraphQL server's internal endpoint.
 * Uses fire-and-forget pattern since the local runtime keeps running.
 */
export const HttpExecutionFromJobPublisherLive = Layer.effect(
  ExecutionFromJobPublisher,
  Effect.gen(function* () {
    const executionOps = yield* ExecutionCollectionOps
    const httpClient = yield* HttpClient.HttpClient
    const userDetails = yield* UserDetails
    const sqlClient = yield* SqlClient.SqlClient
    const callbackSecret = yield* Config.option(
      Config.string("INTERNAL_API_SECRET"),
    )
    const baseUrl = yield* GraphqlServerUrl

    return {
      publishExecutionChanged: (executionId: string) =>
        Effect.gen(function* () {
          // Assembly reads execution, Todos and state separately. Keep one
          // snapshot, but release its transaction before external publication.
          const graphqlExecutions = yield* sqlClient
            .withTransaction(
              Effect.gen(function* () {
                const executions = yield* executionOps.getByIds([executionId])
                return yield* Effect.all(
                  executions.map((execution) =>
                    executionOps.mapToGraphql(execution).pipe(
                      Effect.map((document) => ({
                        ...document,
                        startedByEmail: execution.execution.startedByEmail,
                        startedByRolePath:
                          execution.execution.startedByRolePath,
                      })),
                    ),
                  ),
                )
              }),
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ExecutionFromJobPublishError({
                    executionId,
                    cause,
                  }),
              ),
            )

          // Empty getByIds (or empty map result): expected race on rollback.
          if (!Arr.isNonEmptyReadonlyArray(graphqlExecutions)) {
            return "skipped-not-found" as const
          }

          const lastExecution = Arr.lastNonEmpty(graphqlExecutions)

          const event: ExecutionChangeEvent = {
            documents: graphqlExecutions,
            checkpoint: {
              id: lastExecution.id,
              updatedAt: lastExecution.updatedAt,
            },
          }

          yield* postInternalEvent(
            httpClient,
            baseUrl,
            "/internal/execution-event",
            event,
            callbackSecret,
            (cause) =>
              new ExecutionFromJobPublishError({
                executionId,
                cause,
              }),
          )

          return "published" as const
        }).pipe(Effect.provideService(UserDetails, userDetails)),
    }
  }),
)
