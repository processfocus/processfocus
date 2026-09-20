import { Console, Effect } from "effect"
import type { CliError } from "../../errors"
import { graphqlRequestWithCredentials } from "../../utils/graphql-client"

const LIST_PROJECT_STAGES_QUERY = `
  query ListProjectStages($projectId: String!) {
    listProjectStages(projectId: $projectId) {
      items {
        stageName
      }
    }
  }
`

interface ListProjectStagesResponse {
  readonly listProjectStages: {
    readonly items: ReadonlyArray<{
      readonly stageName: string
    }>
  }
}

export const runStageList = (
  projectId: string,
): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    const response =
      yield* graphqlRequestWithCredentials<ListProjectStagesResponse>(
        LIST_PROJECT_STAGES_QUERY,
        { projectId },
      )

    const { items } = response.listProjectStages

    if (items.length === 0) {
      yield* Console.log(`No stages found for project ${projectId}.`)
      return
    }

    for (const item of items) {
      yield* Console.log(item.stageName)
    }
  })
