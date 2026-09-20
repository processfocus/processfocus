import { Console, Effect } from "effect"
import type { CliError } from "../../errors"
import { graphqlRequestWithCredentials } from "../../utils/graphql-client"
import { ensureKnownStageNames } from "../../utils/remote-name-validation"

const COPY_NEW_CONFIG_PARAMETERS_MUTATION = `
  mutation CopyNewConfigParameters($projectId: String!, $stageId: String!, $fromStageId: String!) {
    copyNewConfigParameters(projectId: $projectId, stageId: $stageId, fromStageId: $fromStageId) {
      copiedCount
      copiedKeys
      sameStage
      skippedCount
    }
  }
`

interface CopyNewConfigParametersResponse {
  copyNewConfigParameters: {
    copiedCount: number
    copiedKeys: ReadonlyArray<string>
    sameStage: boolean
    skippedCount: number
  }
}

/**
 * Run config copy-new command.
 */
export const runConfigCopyNew = (
  projectId: string,
  stageId: string,
  fromStageId: string,
): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    if (stageId === fromStageId) {
      yield* Console.log(
        `Source and destination stage are both ${stageId}. Nothing copied.`,
      )
      return
    }

    yield* ensureKnownStageNames(projectId, [stageId, fromStageId])

    yield* Console.log(
      `Copying new config parameters from stage ${fromStageId} to ${stageId} for project ${projectId}...`,
    )

    const response =
      yield* graphqlRequestWithCredentials<CopyNewConfigParametersResponse>(
        COPY_NEW_CONFIG_PARAMETERS_MUTATION,
        { projectId, stageId, fromStageId },
      )

    const result = response.copyNewConfigParameters

    if (result.sameStage) {
      yield* Console.log(
        `Source and destination stage resolve to the same stage. Nothing copied.`,
      )
      return
    }

    if (result.copiedCount === 0) {
      if (result.skippedCount === 0) {
        yield* Console.log(`No config parameters found in ${fromStageId}.`)
        return
      }

      yield* Console.log(
        `No new config parameters copied. ${result.skippedCount} key${result.skippedCount === 1 ? "" : "s"} already existed in ${stageId}.`,
      )
      return
    }

    yield* Console.log(
      `Copied ${result.copiedCount} new config parameter${result.copiedCount === 1 ? "" : "s"} from ${fromStageId} to ${stageId}.`,
    )

    if (result.skippedCount > 0) {
      yield* Console.log(
        `Skipped ${result.skippedCount} existing key${result.skippedCount === 1 ? "" : "s"}.`,
      )
    }

    yield* Console.log("")
    for (const key of result.copiedKeys) {
      yield* Console.log(`  ${key}`)
    }
  })
