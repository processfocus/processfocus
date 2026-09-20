import { Console, Effect } from "effect"
import { CliError } from "../../errors"
import { graphqlRequestWithCredentials } from "../../utils/graphql-client"
import { ensureKnownStageNames } from "../../utils/remote-name-validation"

const SET_CONFIG_PARAMETER_MUTATION = `
  mutation SetConfigParameter($projectId: String!, $stageId: String!, $key: String!, $value: String!, $isSecret: Boolean!) {
    setConfigParameter(projectId: $projectId, stageId: $stageId, key: $key, value: $value, isSecret: $isSecret)
  }
`

interface SetConfigParameterResponse {
  setConfigParameter: boolean
}

const CONFIG_SET_USAGE =
  "Expected 'config set --project <project> --stage <stage> KEY', 'config set --project <project> --stage <stage> KEY=VALUE', or 'config set --project <project> --stage <stage> KEY VALUE'"

type ConfigAssignment = readonly [key: string, value: string]

export const parseConfigSetAssignment = (
  args: ReadonlyArray<string>,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Effect.Effect<ConfigAssignment, CliError> =>
  Effect.gen(function* () {
    if (args.length === 1) {
      const assignment = args[0]
      if (!assignment) {
        return yield* new CliError({ message: CONFIG_SET_USAGE })
      }

      const separatorIndex = assignment.indexOf("=")
      if (separatorIndex === -1) {
        const value = environment[assignment]
        if (value === undefined) {
          return yield* new CliError({
            message: `Environment variable ${assignment} is unset`,
          })
        }

        return [assignment, value]
      }

      if (separatorIndex === 0) {
        return yield* new CliError({ message: CONFIG_SET_USAGE })
      }

      return [
        assignment.slice(0, separatorIndex),
        assignment.slice(separatorIndex + 1),
      ]
    }

    if (args.length === 2) {
      const [key, value] = args
      if (key && value !== undefined) {
        return [key, value]
      }
    }

    return yield* new CliError({ message: CONFIG_SET_USAGE })
  })

/**
 * Run config set command.
 */
export const runConfigSet = (
  projectId: string,
  stageId: string,
  args: ReadonlyArray<string>,
  isSecret: boolean,
): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    const [key, value] = yield* parseConfigSetAssignment(args)

    yield* ensureKnownStageNames(projectId, [stageId])

    yield* Console.log(
      `Setting config parameter ${key}${isSecret ? " (secret)" : ""} for project ${projectId}, stage ${stageId}...`,
    )

    const response =
      yield* graphqlRequestWithCredentials<SetConfigParameterResponse>(
        SET_CONFIG_PARAMETER_MUTATION,
        { projectId, stageId, key, value, isSecret },
      )

    if (response.setConfigParameter) {
      yield* Console.log(`Successfully set ${key}`)
    } else {
      return yield* new CliError({
        message: "Failed to set config parameter",
      })
    }
  })
