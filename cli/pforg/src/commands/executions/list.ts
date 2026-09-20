import { Console, Effect, Schema } from "effect"
import { CliError } from "../../errors"
import { graphqlRequest } from "../../utils/graphql-client"

const ExecutionListItem = Schema.Struct({
  id: Schema.String,
  processPath: Schema.String,
  processName: Schema.String,
  status: Schema.String,
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  completedSteps: Schema.Number,
  totalSteps: Schema.Number,
  failureReason: Schema.NullOr(Schema.String),
})

const ExecutionsData = Schema.Struct({
  executions: Schema.Struct({ nodes: Schema.Array(ExecutionListItem) }),
})

const EXECUTIONS_QUERY = `
  query Executions($page: Int!, $limit: Int!, $processPath: String, $status: String) {
    executions(page: $page, limit: $limit, processPath: $processPath, status: $status) {
      nodes {
        id
        processPath
        processName
        status
        startedAt
        finishedAt
        completedSteps
        totalSteps
        failureReason
      }
    }
  }
`

export interface ExecutionListOptions {
  readonly page: number
  readonly limit: number
  readonly processPath?: string | undefined
  readonly status?: string | undefined
}

export const runExecutionList = (options: ExecutionListOptions) =>
  Effect.gen(function* () {
    if (options.page < 1) {
      return yield* new CliError({ message: "--page must be at least 1" })
    }
    if (options.limit < 1 || options.limit > 100) {
      return yield* new CliError({
        message: "--limit must be between 1 and 100",
      })
    }

    const data = yield* graphqlRequest(EXECUTIONS_QUERY, {
      variables: {
        page: options.page,
        limit: options.limit,
        processPath: options.processPath ?? null,
        status: options.status ?? null,
      },
      errorMessagePrefix: "",
    })
    const response = yield* Schema.decodeUnknown(ExecutionsData)(data).pipe(
      Effect.mapError(
        (cause) =>
          new CliError({
            message: "GraphQL Execution response has an invalid payload",
            cause,
          }),
      ),
    )

    yield* Console.log(JSON.stringify(response.executions.nodes))
  })
