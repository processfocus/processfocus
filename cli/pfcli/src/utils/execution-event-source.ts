import { Effect } from "effect"
import { CliError } from "../errors"
import { parseAccessTokenUserId } from "./access-token"
import type { Credentials } from "./credentials"
import {
  type ExecutionEventSource,
  createExecutionEventSource,
} from "./execution-subscription"
import { resolveGraphqlWsEndpoint } from "./graphql-client"
import type { SubscriptionTransportResponse } from "./subscription-transport"

interface BuildExecutionEventSourceOptions {
  readonly credentials: Credentials
  readonly subscriptionTransport: SubscriptionTransportResponse["subscriptionTransport"]
  readonly missingUserIdMessage: string
  readonly createExecutionEventSourceImpl?: typeof createExecutionEventSource
}

export const buildExecutionEventSource = ({
  credentials,
  subscriptionTransport,
  missingUserIdMessage,
  createExecutionEventSourceImpl = createExecutionEventSource,
}: BuildExecutionEventSourceOptions): Effect.Effect<
  ExecutionEventSource,
  CliError
> =>
  subscriptionTransport.kind === "APPSYNC_EVENTS"
    ? Effect.gen(function* () {
        const appSyncEventsHttpHost =
          subscriptionTransport.appSyncEventsHttpHost
        if (!appSyncEventsHttpHost) {
          return yield* new CliError({
            message:
              "GraphQL reported AppSync Events subscriptions but did not provide an AppSync host.",
          })
        }

        const userId = parseAccessTokenUserId(credentials.accessToken)
        if (!userId) {
          return yield* new CliError({ message: missingUserIdMessage })
        }

        const baseUrlHost = credentials.baseUrl.replace(/^https?:\/\//, "")
        return yield* createExecutionEventSourceImpl({
          kind: "APPSYNC_EVENTS",
          realtimeUrl: `wss://${baseUrlHost}/event/realtime`,
          appSyncEventsHttpHost,
          accessToken: credentials.accessToken,
          userId,
        })
      })
    : createExecutionEventSourceImpl({
        kind: "GRAPHQL_WS",
        wsEndpoint: resolveGraphqlWsEndpoint(credentials.baseUrl),
        accessToken: credentials.accessToken,
      })

export const closeExecutionEventSource = (
  executionEventSource: ExecutionEventSource,
  errorMessage: string,
): Effect.Effect<void, never> =>
  Effect.tryPromise({
    try: () => executionEventSource.close(),
    catch: (cause) =>
      new CliError({
        message: errorMessage,
        cause,
      }),
  }).pipe(Effect.catchAll(() => Effect.void))
