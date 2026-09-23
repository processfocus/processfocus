import { Effect } from "effect"
import { CliError } from "../errors"
import type { ExecutionSnapshot } from "./execution-subscription"
import { graphqlRequest } from "./graphql-client"

const EXECUTION_LOCATION_QUERY = `
  query DeployExecutionLocation($page: Int!) {
    executions(page: $page, limit: 100) {
      nodes { id startedAt }
      hasNextPage
    }
  }
`

interface ExecutionLocationPage {
  readonly executions: {
    readonly nodes: readonly {
      readonly id: string
      readonly startedAt: string
    }[]
    readonly hasNextPage: boolean
  }
}

const EXECUTION_SNAPSHOT_QUERY = `
  query DeployExecutionSnapshot($checkpoint: PullCheckpoint) {
    pullExecution(checkpoint: $checkpoint, limit: 100) {
      documents {
        id status failureReason abandonedReason finishedAt
        steps { name path status failureReason }
      }
      checkpoint { id updatedAt }
    }
  }
`

interface ExecutionPage {
  readonly pullExecution: {
    readonly documents: readonly ExecutionSnapshot[]
    readonly checkpoint: {
      readonly id: string
      readonly updatedAt: number
    } | null
  }
}

/** Use the same authorized persisted projection as execution subscriptions. */
export const fetchExecutionSnapshot = (
  endpoint: string,
  accessToken: string,
  executionId: string,
): Effect.Effect<ExecutionSnapshot, CliError> =>
  Effect.gen(function* () {
    let checkpoint: ExecutionPage["pullExecution"]["checkpoint"] = null
    // The list is newest-first. Locate this newly submitted execution without
    // replaying historical replication pages, using the server's clock.
    for (let page = 1; checkpoint === null; page++) {
      const { executions } = yield* graphqlRequest<ExecutionLocationPage>(
        endpoint,
        accessToken,
        EXECUTION_LOCATION_QUERY,
        { page },
        { timeoutMs: 30_000 },
      )
      const execution = executions.nodes.find((row) => row.id === executionId)
      if (execution) {
        checkpoint = { id: "", updatedAt: Date.parse(execution.startedAt) }
      } else if (!executions.hasNextPage) {
        return yield* new CliError({
          message: `Deployment execution ${executionId} was not found or is not accessible.`,
        })
      }
    }
    // Keep the full projection for failed steps and abandonment reasons, which
    // the list contract intentionally omits. Empty id includes timestamp ties.
    while (true) {
      const { pullExecution }: ExecutionPage =
        yield* graphqlRequest<ExecutionPage>(
          endpoint,
          accessToken,
          EXECUTION_SNAPSHOT_QUERY,
          { checkpoint },
          { timeoutMs: 30_000 },
        )
      const execution = pullExecution.documents.find(
        (row) => row.id === executionId,
      )
      if (execution) return execution
      if (pullExecution.documents.length === 0 || !pullExecution.checkpoint) {
        return yield* new CliError({
          message: `Deployment execution ${executionId} was not found or is not accessible.`,
        })
      }
      checkpoint = pullExecution.checkpoint
    }
  }).pipe(
    Effect.mapError(
      (cause) =>
        new CliError({
          message: `Failed to read deployment execution status: ${cause.message}`,
          cause,
        }),
    ),
  )
