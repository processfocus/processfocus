import { Console, Effect } from "effect"
import type { CliError } from "../../errors"
import { graphqlRequestWithCredentials } from "../../utils/graphql-client"
import { ensureKnownStageNames } from "../../utils/remote-name-validation"

const LIST_CONFIG_PARAMETERS_QUERY = `
  query ListConfigParameters($projectId: String!, $stageId: String!) {
    listConfigParameters(projectId: $projectId, stageId: $stageId) {
      items {
        name
        value
        isSecret
      }
    }
  }
`

interface ListConfigParametersResponse {
  listConfigParameters: {
    items: Array<{
      name: string
      value: string | null
      isSecret: boolean
    }>
  }
}

/**
 * Run config list command.
 */
export const runConfigList = (
  projectId: string,
  stageId: string,
): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    yield* ensureKnownStageNames(projectId, [stageId])

    yield* Console.log(
      `Fetching config parameters for project ${projectId}, stage ${stageId}...`,
    )

    const response =
      yield* graphqlRequestWithCredentials<ListConfigParametersResponse>(
        LIST_CONFIG_PARAMETERS_QUERY,
        { projectId, stageId },
      )

    const { items } = response.listConfigParameters

    if (items.length === 0) {
      yield* Console.log("No config parameters found.")
      return
    }

    yield* Console.log(`\nConfig parameters (${items.length} total):\n`)
    for (const item of items) {
      const value = item.isSecret ? "***" : (item.value ?? "(empty)")
      yield* Console.log(
        `  ${item.name}${item.isSecret ? " (secret)" : ""}: ${value}`,
      )
    }
  })
