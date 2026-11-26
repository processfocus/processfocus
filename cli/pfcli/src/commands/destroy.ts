import { Console, Effect } from "effect"
import { CliError } from "../errors"
import { acquireAccessToken } from "../utils/credentials"
import {
  buildExecutionEventSource,
  closeExecutionEventSource,
} from "../utils/execution-event-source"
import { formatExecutionLogMessage } from "../utils/execution-log-format"
import { workloadExecutionPoll } from "../utils/execution-snapshot"
import { createExecutionEventSource } from "../utils/execution-subscription"
import {
  extractExecutionFailureMessage,
  waitForExecutionToFinish,
} from "../utils/execution-wait"
import {
  graphqlRequest,
  readCredentialsOrFail,
  resolveGraphqlEndpoint,
} from "../utils/graphql-client"
import { ensureKnownEnvironmentName } from "../utils/remote-name-validation"
import { writeStartReceipt } from "../utils/start-receipt"
import { formatStructuredLogLine } from "../utils/structured-log"
import {
  SUBSCRIPTION_TRANSPORT_QUERY,
  type SubscriptionTransportResponse,
} from "../utils/subscription-transport"

const START_DESTROY_ENVIRONMENT_MUTATION = `
  mutation StartDestroyEnvironment($projectId: String!, $environmentId: String!, $executionId: ID) {
    startOperationsDestroyEnvironment(input: { projectId: $projectId, environmentId: $environmentId }, executionId: $executionId) {
      executionId
      processPath
    }
  }
`

interface StartDestroyEnvironmentResponse {
  readonly startOperationsDestroyEnvironment: {
    readonly executionId: string
    readonly processPath: string
  }
}

interface RunDestroyOptions {
  readonly waitForCompletion?: boolean
  readonly executionId?: string | undefined
}

interface RunDestroyDependencies {
  readonly createExecutionEventSource?: typeof createExecutionEventSource
}

const DESTROY_WAIT_TIMEOUT_MS = 45 * 60 * 1000
const DESTROY_WAIT_HEARTBEAT_MS = 10 * 1000

export const runDestroy = (
  projectId: string,
  environmentId: string,
  options: RunDestroyOptions = {},
  dependencies: RunDestroyDependencies = {},
) => {
  const createExecutionEventSourceImpl =
    dependencies.createExecutionEventSource ?? createExecutionEventSource
  const waitForCompletion = options.waitForCompletion ?? true

  return Effect.gen(function* () {
    yield* ensureKnownEnvironmentName(
      projectId,
      environmentId,
      "destroy-environment",
    )

    const credentials = yield* readCredentialsOrFail("destroy-environment")
    const endpoint = resolveGraphqlEndpoint(credentials.baseUrl)

    const startDestroy = () =>
      Effect.gen(function* () {
        yield* writeStartReceipt(options.executionId)
        const destroyResult =
          yield* graphqlRequest<StartDestroyEnvironmentResponse>(
            endpoint,
            acquireAccessToken(credentials),
            START_DESTROY_ENVIRONMENT_MUTATION,
            { projectId, environmentId, executionId: options.executionId },
          )

        yield* Console.log(
          formatStructuredLogLine("Destroy started", {
            executionId:
              destroyResult.startOperationsDestroyEnvironment.executionId,
          }),
        )

        return destroyResult.startOperationsDestroyEnvironment
      })

    if (!waitForCompletion) {
      yield* startDestroy()
      return
    }

    const subscriptionTransport =
      yield* graphqlRequest<SubscriptionTransportResponse>(
        endpoint,
        acquireAccessToken(credentials),
        SUBSCRIPTION_TRANSPORT_QUERY,
        {},
      )

    const executionEventSource = yield* buildExecutionEventSource({
      credentials,
      subscriptionTransport: subscriptionTransport.subscriptionTransport,
      missingUserIdMessage:
        "CLI access token is missing userId/sub claims required for destroy subscriptions.",
      createExecutionEventSourceImpl,
    })

    const closeEventSource = closeExecutionEventSource(
      executionEventSource,
      "Failed to close destroy execution subscription.",
    )

    return yield* Effect.gen(function* () {
      const destroyStart = yield* startDestroy()
      const waitStartedAt = Date.now()
      yield* Effect.sync(() =>
        process.stdout.write(
          formatExecutionLogMessage(
            "Waiting for environment destruction to complete...",
            waitStartedAt,
          ),
        ),
      )

      const terminalExecution = yield* waitForExecutionToFinish(
        executionEventSource,
        destroyStart.executionId,
        {
          ...workloadExecutionPoll(
            endpoint,
            credentials,
            destroyStart.executionId,
          ),
          executionLabel: "environment destruction",
          timeoutMs: DESTROY_WAIT_TIMEOUT_MS,
          heartbeatMs: DESTROY_WAIT_HEARTBEAT_MS,
          hasPendingInitialLine: true,
          formatLogMessage: formatExecutionLogMessage,
          includeExecutionIdInTimeout: true,
        },
      )

      if (terminalExecution.status === "Completed") {
        yield* Console.log(`Environment destroyed: ${environmentId}`)
        return
      }

      return yield* new CliError({
        message:
          extractExecutionFailureMessage(terminalExecution) ??
          `Environment destruction ${terminalExecution.status.toLowerCase()}.`,
      })
    }).pipe(Effect.ensuring(closeEventSource))
  })
}
