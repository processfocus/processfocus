import { Console, Effect, Schema } from "effect"
import { CliError } from "../errors"
import { acquireAccessToken } from "../utils/credentials"
import {
  graphqlRequest,
  readCredentialsOrFail,
  resolveGraphqlEndpoint,
} from "../utils/graphql-client"

const Options = Schema.Struct({
  consoleProjectCreationOptions: Schema.Struct({
    regions: Schema.Array(
      Schema.Struct({ value: Schema.String, label: Schema.String }),
    ),
  }),
})
const Started = Schema.Struct({
  startOperationsProjectSignup: Schema.Struct({
    executionId: Schema.NonEmptyString,
  }),
})
const Receipt = Schema.Struct({
  consoleProjectCreation: Schema.Struct({
    status: Schema.Literals(["PENDING", "FAILED", "SUCCEEDED"]),
    projectId: Schema.NullOr(Schema.String),
    projectNumber: Schema.NullOr(Schema.String),
  }),
})

export const runProjectCreate = (input: {
  readonly name: string
  readonly region: string
}): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    if (!input.name.trim() || !input.region.trim()) {
      return yield* new CliError({
        message: "Project name and region must not be empty.",
      })
    }
    const credentials = yield* readCredentialsOrFail()
    const endpoint = resolveGraphqlEndpoint(credentials.baseUrl)
    const request = (query: string, variables: Record<string, unknown>) =>
      graphqlRequest<unknown>(
        endpoint,
        acquireAccessToken(credentials),
        query,
        variables,
        { timeoutMs: 15_000 },
      )
    const options = yield* request(
      "query { consoleProjectCreationOptions { regions { value label } } }",
      {},
    ).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Options)),
      Effect.mapError(
        (cause) =>
          new CliError({
            message: "Unable to read project creation options.",
            cause,
          }),
      ),
    )
    const regions = options.consoleProjectCreationOptions.regions
    const region = regions.find((item) => item.value === input.region)
    if (!region) {
      return yield* new CliError({
        message: `Unknown region ${input.region}. Available: ${regions.map((item) => `${item.value} (${item.label})`).join(", ")}`,
      })
    }
    // Never retry this mutation: a lost response may still have created a project.
    const started = yield* request(
      `mutation CreateProject($input: OperationsProjectSignupInputProjectDetails!) {
        startOperationsProjectSignup(input: $input) { executionId }
      }`,
      { input: { projectName: input.name.trim(), regionId: region.value } },
    ).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Started)),
      Effect.mapError(
        (cause) =>
          new CliError({
            message:
              "Project creation outcome is uncertain. Check pfcli projects before retrying.",
            cause,
          }),
      ),
    )
    const executionId = started.startOperationsProjectSignup.executionId
    yield* Console.log(JSON.stringify({ status: "started", executionId }))
    for (let attempt = 0; attempt < 120; attempt++) {
      const receipt = yield* request(
        `query ProjectCreation($executionId: ID!) {
          consoleProjectCreation(executionId: $executionId) { status projectId projectNumber }
        }`,
        { executionId },
      ).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Receipt)),
        Effect.mapError(
          (cause) =>
            new CliError({
              message: `Unable to read project creation ${executionId}; check its outcome before retrying.`,
              cause,
            }),
        ),
      )
      const result = receipt.consoleProjectCreation
      if (result.status === "FAILED") {
        return yield* new CliError({
          message: `Project creation ${executionId} failed.`,
        })
      }
      if (result.status === "SUCCEEDED") {
        if (!result.projectId || !result.projectNumber) {
          return yield* new CliError({
            message: `Project creation ${executionId} returned an incomplete receipt.`,
          })
        }
        yield* Console.log(JSON.stringify({ ...result, executionId }))
        return
      }
      yield* Effect.sleep("2 seconds")
    }
    return yield* new CliError({
      message: `Timed out waiting for project creation ${executionId}. Check its outcome before retrying.`,
    })
  })
