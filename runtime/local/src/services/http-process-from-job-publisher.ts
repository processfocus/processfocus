import { HttpClient } from "@effect/platform"
import { Array as Arr, Config, Effect, Layer } from "effect"
import { type ProcessChangeEvent, ProcessCollectionOps } from "@pf/graphql-api"
import { UserDetails } from "@pf/graphql-db-operations"
import {
  ProcessFromJobPublishError,
  ProcessFromJobPublisher,
} from "@pf/job-handler"
import { GraphqlServerUrl } from "./graphql-server-config"
import { postInternalEvent } from "./post-internal-event"

/**
 * ProcessFromJobPublisher implementation for local runtime.
 * Publishes process change events via HTTP POST to the GraphQL server's internal endpoint.
 * Uses fire-and-forget pattern since the local runtime keeps running.
 */
export const HttpProcessFromJobPublisherLive = Layer.effect(
  ProcessFromJobPublisher,
  Effect.gen(function* () {
    const processOps = yield* ProcessCollectionOps
    const httpClient = yield* HttpClient.HttpClient
    const userDetails = yield* UserDetails
    const callbackSecret = yield* Config.option(
      Config.string("INTERNAL_API_SECRET"),
    )
    const baseUrl = yield* GraphqlServerUrl

    return {
      publishProcessChanged: (processId: string) =>
        Effect.gen(function* () {
          const processes = yield* processOps.getByIds([processId]).pipe(
            Effect.mapError(
              (cause) =>
                new ProcessFromJobPublishError({
                  processId,
                  cause,
                }),
            ),
          )

          const graphqlProcesses = yield* Effect.all(
            processes.map((process) => processOps.mapToGraphql(process)),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ProcessFromJobPublishError({
                  processId,
                  cause,
                }),
            ),
          )

          // Empty getByIds (or empty map result): expected race on rollback.
          if (!Arr.isNonEmptyReadonlyArray(graphqlProcesses)) {
            return "skipped-not-found" as const
          }

          const lastProcess = Arr.lastNonEmpty(graphqlProcesses)

          const event: ProcessChangeEvent = {
            documents: graphqlProcesses,
            checkpoint: {
              id: lastProcess.id,
              updatedAt: lastProcess.updatedAt,
            },
          }

          yield* postInternalEvent(
            httpClient,
            baseUrl,
            "/internal/process-event",
            event,
            callbackSecret,
            (cause) =>
              new ProcessFromJobPublishError({
                processId,
                cause,
              }),
          )

          return "published" as const
        }).pipe(Effect.provideService(UserDetails, userDetails)),
    }
  }),
)
