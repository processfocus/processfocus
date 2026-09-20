import { Console, Effect } from "effect"
import { CliError } from "../../errors"
import {
  buildExecutionEventSource,
  closeExecutionEventSource,
} from "../../utils/execution-event-source"
import { formatExecutionLogMessage } from "../../utils/execution-log-format"
import { createExecutionEventSource } from "../../utils/execution-subscription"
import {
  extractExecutionFailureMessage,
  waitForExecutionToFinish,
} from "../../utils/execution-wait"
import {
  graphqlRequest,
  readCredentialsOrFail,
  resolveGraphqlEndpoint,
} from "../../utils/graphql-client"
import { ensureKnownStageNames } from "../../utils/remote-name-validation"
import { formatStructuredLogLine } from "../../utils/structured-log"
import {
  SUBSCRIPTION_TRANSPORT_QUERY,
  type SubscriptionTransportResponse,
} from "../../utils/subscription-transport"

const START_ADD_ENVIRONMENT_MUTATION = `
  mutation StartAddEnvironment($projectId: String!, $stageId: String!, $environmentName: String!) {
    startOperationsAddEnvironment(input: { projectId: $projectId, stageId: $stageId, environmentName: $environmentName }) {
      executionId
      processPath
    }
  }
`

interface StartAddEnvironmentResponse {
  startOperationsAddEnvironment: {
    executionId: string
    processPath: string
  }
}

interface RunEnvAddDependencies {
  createExecutionEventSource?: typeof createExecutionEventSource
}

const ENV_ADD_WAIT_TIMEOUT_MS = 15 * 60 * 1000
const ENV_ADD_WAIT_HEARTBEAT_MS = 10 * 1000

export const runEnvAdd = (
  projectId: string,
  stageId: string,
  environmentName: string,
  dependencies: RunEnvAddDependencies = {},
) => {
  const createExecutionEventSourceImpl =
    dependencies.createExecutionEventSource ?? createExecutionEventSource

  return Effect.gen(function* () {
    yield* ensureKnownStageNames(projectId, [stageId])

    const credentials = yield* readCredentialsOrFail()
    const endpoint = resolveGraphqlEndpoint(credentials.baseUrl)

    const subscriptionTransport =
      yield* graphqlRequest<SubscriptionTransportResponse>(
        endpoint,
        credentials.accessToken,
        SUBSCRIPTION_TRANSPORT_QUERY,
        {},
      )

    const executionEventSource = yield* buildExecutionEventSource({
      credentials,
      subscriptionTransport: subscriptionTransport.subscriptionTransport,
      missingUserIdMessage:
        "CLI access token is missing userId/sub claims required for env add subscriptions.",
      createExecutionEventSourceImpl,
    })

    const closeEventSource = closeExecutionEventSource(
      executionEventSource,
      "Failed to close env add execution subscription.",
    )

    return yield* Effect.gen(function* () {
      const addEnvironmentResult =
        yield* graphqlRequest<StartAddEnvironmentResponse>(
          endpoint,
          credentials.accessToken,
          START_ADD_ENVIRONMENT_MUTATION,
          {
            projectId,
            stageId,
            environmentName,
          },
        )

      yield* Console.log(
        formatStructuredLogLine("Environment add started", {
          executionId:
            addEnvironmentResult.startOperationsAddEnvironment.executionId,
        }),
      )

      const waitStartedAt = Date.now()
      yield* Effect.sync(() =>
        process.stdout.write(
          formatExecutionLogMessage(
            "Waiting for environment creation to complete...",
            waitStartedAt,
          ),
        ),
      )

      const terminalExecution = yield* waitForExecutionToFinish(
        executionEventSource,
        addEnvironmentResult.startOperationsAddEnvironment.executionId,
        {
          executionLabel: "environment creation",
          timeoutMs: ENV_ADD_WAIT_TIMEOUT_MS,
          heartbeatMs: ENV_ADD_WAIT_HEARTBEAT_MS,
          hasPendingInitialLine: true,
          formatLogMessage: formatExecutionLogMessage,
          includeExecutionIdInTimeout: true,
        },
      )

      if (terminalExecution.status === "Completed") {
        yield* Console.log(`Environment created: ${environmentName}`)
        return
      }

      return yield* new CliError({
        message:
          extractExecutionFailureMessage(terminalExecution) ??
          `Environment creation ${terminalExecution.status.toLowerCase()}.`,
      })
    }).pipe(Effect.ensuring(closeEventSource))
  })
}
