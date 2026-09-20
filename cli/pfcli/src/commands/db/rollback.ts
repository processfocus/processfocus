import { Console, Effect } from "effect"
import { CliError } from "../../errors"
import {
  buildExecutionEventSource,
  closeExecutionEventSource,
} from "../../utils/execution-event-source"
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
import { ensureKnownEnvironmentName } from "../../utils/remote-name-validation"
import { formatStructuredLogLine } from "../../utils/structured-log"
import {
  SUBSCRIPTION_TRANSPORT_QUERY,
  type SubscriptionTransportResponse,
} from "../../utils/subscription-transport"

const START_ROLLBACK_DB_MUTATION = `
  mutation StartRollbackDb($projectId: String!, $environmentId: String!, $timestamp: String!) {
    startOperationsRollbackDb(input: { projectId: $projectId, environmentId: $environmentId, timestamp: $timestamp }) {
      executionId
      processPath
    }
  }
`

interface StartRollbackDbResponse {
  startOperationsRollbackDb: {
    executionId: string
    processPath: string
  }
}

interface RunRollbackDbOptions {
  waitForCompletion?: boolean
}

interface RunRollbackDbDependencies {
  createExecutionEventSource?: typeof createExecutionEventSource
}

const ROLLBACK_WAIT_TIMEOUT_MS = 15 * 60 * 1000
const ROLLBACK_WAIT_HEARTBEAT_MS = 10 * 1000

const formatLocalTimestamp = (now = Date.now()): string => {
  const date = new Date(now)

  return `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`
}

const formatRollbackLogMessage = (message: string, now = Date.now()): string =>
  `[${formatLocalTimestamp(now)}] ${message}`

export const runRollbackDb = (
  projectId: string,
  environmentId: string,
  timestamp: string,
  options: RunRollbackDbOptions = {},
  dependencies: RunRollbackDbDependencies = {},
) => {
  const createExecutionEventSourceImpl =
    dependencies.createExecutionEventSource ?? createExecutionEventSource
  const waitForCompletion = options.waitForCompletion ?? true

  return Effect.gen(function* () {
    yield* ensureKnownEnvironmentName(projectId, environmentId)

    const credentials = yield* readCredentialsOrFail()

    const endpoint = resolveGraphqlEndpoint(credentials.baseUrl)

    const startRollback = () =>
      Effect.gen(function* () {
        const rollbackResult = yield* graphqlRequest<StartRollbackDbResponse>(
          endpoint,
          credentials.accessToken,
          START_ROLLBACK_DB_MUTATION,
          {
            projectId,
            environmentId,
            timestamp,
          },
        )

        yield* Console.log(
          formatStructuredLogLine("Rollback started", {
            executionId: rollbackResult.startOperationsRollbackDb.executionId,
          }),
        )

        return rollbackResult.startOperationsRollbackDb
      })

    if (!waitForCompletion) {
      yield* startRollback()
      return
    }

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
        "CLI access token is missing userId/sub claims required for rollback subscriptions.",
      createExecutionEventSourceImpl,
    })

    const closeEventSource = closeExecutionEventSource(
      executionEventSource,
      "Failed to close rollback execution subscription.",
    )

    return yield* Effect.gen(function* () {
      const rollbackStart = yield* startRollback()
      const waitStartedAt = Date.now()
      yield* Effect.sync(() =>
        process.stdout.write(
          formatRollbackLogMessage(
            "Waiting for rollback completion...",
            waitStartedAt,
          ),
        ),
      )

      const terminalExecution = yield* waitForExecutionToFinish(
        executionEventSource,
        rollbackStart.executionId,
        {
          executionLabel: "rollback",
          timeoutMs: ROLLBACK_WAIT_TIMEOUT_MS,
          heartbeatMs: ROLLBACK_WAIT_HEARTBEAT_MS,
          hasPendingInitialLine: true,
          formatLogMessage: formatRollbackLogMessage,
        },
      )

      if (terminalExecution.status === "Completed") {
        yield* Console.log(formatRollbackLogMessage("Rollback completed."))
        return
      }

      return yield* new CliError({
        message:
          extractExecutionFailureMessage(terminalExecution) ??
          `Rollback ${terminalExecution.status.toLowerCase()}.`,
      })
    }).pipe(Effect.ensuring(closeEventSource))
  })
}
