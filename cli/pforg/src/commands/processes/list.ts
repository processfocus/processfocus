import { Console, Effect, Schema } from "effect"
import { CliError } from "../../errors"
import { graphqlRequest } from "../../utils/graphql-client"

const ProcessListItem = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  name: Schema.String,
  category: Schema.String,
  purpose: Schema.String,
  startStepPath: Schema.String,
  activeInstances: Schema.Number,
})

const ProcessesData = Schema.Struct({
  processes: Schema.Struct({ nodes: Schema.Array(ProcessListItem) }),
})

const PROCESSES_QUERY = `
  query Processes($page: Int!, $limit: Int!, $processPath: String, $status: String) {
    processes(page: $page, limit: $limit, processPath: $processPath, status: $status) {
      nodes {
        id
        path
        name
        category
        purpose
        startStepPath
        activeInstances
      }
    }
  }
`

export interface ProcessListOptions {
  readonly page: number
  readonly limit: number
  readonly processPath?: string | undefined
  readonly status?: string | undefined
}

export const runProcessList = (options: ProcessListOptions) =>
  Effect.gen(function* () {
    if (options.page < 1) {
      return yield* new CliError({ message: "--page must be at least 1" })
    }
    if (options.limit < 1 || options.limit > 100) {
      return yield* new CliError({
        message: "--limit must be between 1 and 100",
      })
    }

    const data = yield* graphqlRequest(PROCESSES_QUERY, {
      variables: {
        page: options.page,
        limit: options.limit,
        processPath: options.processPath ?? null,
        status: options.status ?? null,
      },
      errorMessagePrefix: "",
    })
    const response = yield* Schema.decodeUnknown(ProcessesData)(data).pipe(
      Effect.mapError(
        (cause) =>
          new CliError({
            message: "GraphQL Process response has an invalid payload",
            cause,
          }),
      ),
    )

    yield* Console.log(JSON.stringify(response.processes.nodes))
  })
