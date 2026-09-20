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
import { formatStructuredLogLine } from "../../utils/structured-log"
import {
  SUBSCRIPTION_TRANSPORT_QUERY,
  type SubscriptionTransportResponse,
} from "../../utils/subscription-transport"

const START_ADD_STAGE_MUTATION = `
  mutation StartAddStage($projectId: String!, $stageName: String!) {
    startOperationsAddStage(input: { projectId: $projectId, stageName: $stageName }) {
      executionId
      processPath
    }
  }
`

interface StartAddStageResponse {
  startOperationsAddStage: {
    executionId: string
    processPath: string
  }
}

interface RunStageAddDependencies {
  createExecutionEventSource?: typeof createExecutionEventSource
}

const STAGE_ADD_WAIT_TIMEOUT_MS = 15 * 60 * 1000
const STAGE_ADD_WAIT_HEARTBEAT_MS = 10 * 1000

const normalizeStageAddFailureMessage = (
  message: string,
  stageName: string,
): string => {
  const duplicateMessage = `Stage "${stageName}" already exists in this project.`

  return message.includes(duplicateMessage) ? duplicateMessage : message
}

export const runStageAdd = (
  projectId: string,
  stageName: string,
  dependencies: RunStageAddDependencies = {},
) => {
  const createExecutionEventSourceImpl =
    dependencies.createExecutionEventSource ?? createExecutionEventSource

  return Effect.gen(function* () {
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
        "CLI access token is missing userId/sub claims required for stage add subscriptions.",
      createExecutionEventSourceImpl,
    })

    const closeEventSource = closeExecutionEventSource(
      executionEventSource,
      "Failed to close stage add execution subscription.",
    )

    return yield* Effect.gen(function* () {
      const addStageResult = yield* graphqlRequest<StartAddStageResponse>(
        endpoint,
        credentials.accessToken,
        START_ADD_STAGE_MUTATION,
        {
          projectId,
          stageName,
        },
      )

      yield* Console.log(
        formatStructuredLogLine("Stage add started", {
          executionId: addStageResult.startOperationsAddStage.executionId,
        }),
      )

      const waitStartedAt = Date.now()
      yield* Effect.sync(() =>
        process.stdout.write(
          formatExecutionLogMessage(
            "Waiting for stage creation to complete...",
            waitStartedAt,
          ),
        ),
      )

      const terminalExecution = yield* waitForExecutionToFinish(
        executionEventSource,
        addStageResult.startOperationsAddStage.executionId,
        {
          executionLabel: "stage creation",
          timeoutMs: STAGE_ADD_WAIT_TIMEOUT_MS,
          heartbeatMs: STAGE_ADD_WAIT_HEARTBEAT_MS,
          hasPendingInitialLine: true,
          formatLogMessage: formatExecutionLogMessage,
          includeExecutionIdInTimeout: true,
        },
      )

      if (terminalExecution.status === "Completed") {
        yield* Console.log(`Stage created: ${stageName}`)
        return
      }

      const failureMessage =
        extractExecutionFailureMessage(terminalExecution) ??
        `Stage creation ${terminalExecution.status.toLowerCase()}.`

      return yield* new CliError({
        message: normalizeStageAddFailureMessage(failureMessage, stageName),
      })
    }).pipe(Effect.ensuring(closeEventSource))
  })
}
