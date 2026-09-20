import { Console, Effect } from "effect"
import { CliError } from "../../errors"
import { graphqlRequestWithCredentials } from "../../utils/graphql-client"
import { ensureKnownStageNames } from "../../utils/remote-name-validation"

const DELETE_CONFIG_PARAMETER_MUTATION = `
  mutation DeleteConfigParameter($projectId: String!, $stageId: String!, $key: String!) {
    deleteConfigParameter(projectId: $projectId, stageId: $stageId, key: $key)
  }
`

interface DeleteConfigParameterResponse {
  deleteConfigParameter: boolean
}

/**
 * Run config delete command.
 */
export const runConfigDelete = (
  projectId: string,
  stageId: string,
  key: string,
): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    yield* ensureKnownStageNames(projectId, [stageId])

    yield* Console.log(
      `Deleting config parameter ${key} for project ${projectId}, stage ${stageId}...`,
    )

    const response =
      yield* graphqlRequestWithCredentials<DeleteConfigParameterResponse>(
        DELETE_CONFIG_PARAMETER_MUTATION,
        { projectId, stageId, key },
      )

    if (response.deleteConfigParameter) {
      yield* Console.log(`Successfully deleted ${key}`)
    } else {
      return yield* new CliError({
        message: "Failed to delete config parameter",
      })
    }
  })
