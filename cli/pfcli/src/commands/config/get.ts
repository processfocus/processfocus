import { Console, Effect } from "effect"
import type { CliError } from "../../errors"
import { graphqlRequestWithCredentials } from "../../utils/graphql-client"
import { ensureKnownStageNames } from "../../utils/remote-name-validation"

const GET_CONFIG_PARAMETER_QUERY = `
  query GetConfigParameter($projectId: String!, $stageId: String!, $key: String!) {
    getConfigParameter(projectId: $projectId, stageId: $stageId, key: $key) {
      name
      value
      isSecret
    }
  }
`

interface GetConfigParameterResponse {
  getConfigParameter: {
    name: string
    value: string | null
    isSecret: boolean
  } | null
}

/**
 * Run config get command.
 */
export const runConfigGet = (
  projectId: string,
  stageId: string,
  key: string,
): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    yield* ensureKnownStageNames(projectId, [stageId])

    yield* Console.log(
      `Fetching config parameter ${key} for project ${projectId}, stage ${stageId}...`,
    )

    const response =
      yield* graphqlRequestWithCredentials<GetConfigParameterResponse>(
        GET_CONFIG_PARAMETER_QUERY,
        { projectId, stageId, key },
      )

    const param = response.getConfigParameter

    if (!param) {
      yield* Console.log(`Parameter ${key} not found.`)
      return
    }

    const value = param.isSecret ? "***" : (param.value ?? "(empty)")
    yield* Console.log(
      `${param.name}${param.isSecret ? " (secret)" : ""}: ${value}`,
    )
  })
