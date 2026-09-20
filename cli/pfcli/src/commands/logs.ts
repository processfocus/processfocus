import { Console, Effect } from "effect"
import { CliError } from "../errors"
import { graphqlRequestWithCredentials } from "../utils/graphql-client"
import { ensureKnownEnvironmentName } from "../utils/remote-name-validation"

const GET_RUNTIME_LOGS_QUERY = `
  query GetRuntimeLogs($projectId: String!, $environmentId: String!, $target: RuntimeLogTarget!, $limit: Int) {
    getRuntimeLogs(projectId: $projectId, environmentId: $environmentId, target: $target, limit: $limit) {
      events {
        timestamp
        message
      }
    }
  }
`

const RUNTIME_LOG_LIMIT = 100

interface RuntimeLogEvent {
  readonly timestamp: string
  readonly message: string
}

interface GetRuntimeLogsResponse {
  readonly getRuntimeLogs: {
    readonly events: readonly RuntimeLogEvent[]
  }
}

type RuntimeLogTarget = "PRIMARY" | "CANARY"

const runRuntimeLogs = (
  projectId: string,
  environmentId: string,
  target: RuntimeLogTarget,
) =>
  ensureKnownEnvironmentName(projectId, environmentId).pipe(
    Effect.flatMap(() =>
      graphqlRequestWithCredentials<GetRuntimeLogsResponse>(
        GET_RUNTIME_LOGS_QUERY,
        {
          projectId,
          environmentId,
          target,
          limit: RUNTIME_LOG_LIMIT,
        },
      ),
    ),
    Effect.mapError(
      (error) =>
        new CliError({
          message: error.message,
          cause: error.cause,
        }),
    ),
    Effect.flatMap(({ getRuntimeLogs }) =>
      Effect.gen(function* () {
        const label = target.toLowerCase()

        yield* Console.log(`Showing recent ${label} logs.`)

        if (getRuntimeLogs.events.length === 0) {
          yield* Console.log(`No recent ${label} logs found.`)
          return
        }

        for (const event of getRuntimeLogs.events) {
          yield* Console.log(`${event.timestamp} ${event.message}`)
        }
      }),
    ),
  )

export const runLogs = (projectId: string, environmentId: string) =>
  runRuntimeLogs(projectId, environmentId, "PRIMARY")

export const runCanaryLogs = (projectId: string, environmentId: string) =>
  runRuntimeLogs(projectId, environmentId, "CANARY")
