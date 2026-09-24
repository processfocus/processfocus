import { Effect } from "effect"
import { CliError } from "../errors"
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
  accessToken: string,
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
