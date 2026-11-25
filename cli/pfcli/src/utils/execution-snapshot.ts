import { Effect } from "effect"
import { CliError } from "../errors"
import { type Credentials, acquireAccessToken } from "./credentials"
import type { ExecutionSnapshot } from "./execution-subscription"
import { graphqlRequest } from "./graphql-client"

const EXECUTION_SNAPSHOT_QUERY = `
  query DeployExecutionSnapshot($id: ID!) {
    execution(id: $id) {
      id status failureReason abandonedReason finishedAt
      steps { name path status failureReason }
    }
  }
`

/** Use the same authorized persisted projection as execution subscriptions. */
export const fetchExecutionSnapshot = (
  endpoint: string,
  accessToken: string | Effect.Effect<string, CliError>,
  executionId: string,
): Effect.Effect<ExecutionSnapshot, CliError> =>
  Effect.gen(function* () {
    const { execution } = yield* graphqlRequest<{
      readonly execution: ExecutionSnapshot | null
    }>(
      endpoint,
      accessToken,
      EXECUTION_SNAPSHOT_QUERY,
      { id: executionId },
      {
        timeoutMs: 30_000,
      },
    )
    if (!execution) {
      return yield* new CliError({
        message: `Deployment execution ${executionId} was not found or is not accessible.`,
      })
    }
    return execution
  }).pipe(
    Effect.mapError(
      (cause) =>
        new CliError({
          message: `Failed to read deployment execution status: ${cause.message}`,
          cause,
        }),
    ),
  )

/** A renewed subscription can miss a terminal event while reconnecting. */
export const workloadExecutionPoll = (
  endpoint: string,
  credentials: Credentials,
  executionId: string,
) =>
  credentials.workload
    ? {
        fetchSnapshot: (signal: AbortSignal) =>
          Effect.runPromise(
            fetchExecutionSnapshot(
              endpoint,
              acquireAccessToken(credentials),
              executionId,
            ),
            { signal },
          ),
      }
    : {}
