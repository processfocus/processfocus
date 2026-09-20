import { Console, Effect } from "effect"
import type { CliError } from "../../errors"
import { graphqlRequestWithCredentials } from "../../utils/graphql-client"
import { ensureKnownStageNames } from "../../utils/remote-name-validation"

const LIST_PROJECT_ENVIRONMENTS_QUERY = `
  query ListProjectEnvironments($projectId: String!, $stageId: String) {
    listProjectEnvironments(projectId: $projectId, stageId: $stageId) {
      items {
        environmentName
        stageName
      }
    }
  }
`

interface ListProjectEnvironmentsResponse {
  readonly listProjectEnvironments: {
    readonly items: ReadonlyArray<{
      readonly environmentName: string
      readonly stageName: string
    }>
  }
}

export const runEnvList = (
  projectId: string,
  stageId?: string,
): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    if (stageId) {
      yield* ensureKnownStageNames(projectId, [stageId])
    }

    const response =
      yield* graphqlRequestWithCredentials<ListProjectEnvironmentsResponse>(
        LIST_PROJECT_ENVIRONMENTS_QUERY,
        { projectId, stageId },
      )

    const { items } = response.listProjectEnvironments

    if (items.length === 0) {
      const stageScope = stageId ? ` stage ${stageId}` : ""
      yield* Console.log(
        `No environments found for project ${projectId}${stageScope}.`,
      )
      return
    }

    for (const item of items) {
      yield* Console.log(
        stageId
          ? item.environmentName
          : `${item.environmentName} (${item.stageName})`,
      )
    }
  })
