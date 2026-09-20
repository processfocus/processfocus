import { Console, Effect, Schema } from "effect"
import { CliError } from "../../errors"
import { graphqlRequest } from "../../utils/graphql-client"

const TodoListItem = Schema.Struct({
  id: Schema.String,
  processExecutionId: Schema.String,
  processName: Schema.String,
  stepName: Schema.String,
  stepPath: Schema.String,
  role: Schema.String,
  status: Schema.String,
  priority: Schema.String,
  assignedAt: Schema.String,
  dueAt: Schema.NullOr(Schema.String),
  description: Schema.String,
  summary: Schema.Array(
    Schema.Struct({ label: Schema.String, value: Schema.String }),
  ),
})

const TodosData = Schema.Struct({
  todos: Schema.Struct({ nodes: Schema.Array(TodoListItem) }),
})

const TODOS_QUERY = `
  query Todos($page: Int!, $limit: Int!, $processPath: String, $status: String) {
    todos(page: $page, limit: $limit, processPath: $processPath, status: $status) {
      nodes {
        id
        processExecutionId
        processName
        stepName
        stepPath
        role
        status
        priority
        assignedAt
        dueAt
        description
        summary { label value }
      }
    }
  }
`

export interface TodoListOptions {
  readonly page: number
  readonly limit: number
  readonly processPath?: string | undefined
  readonly status?: string | undefined
}

export const runTodoList = (options: TodoListOptions) =>
  Effect.gen(function* () {
    if (options.page < 1) {
      return yield* new CliError({ message: "--page must be at least 1" })
    }
    if (options.limit < 1 || options.limit > 100) {
      return yield* new CliError({
        message: "--limit must be between 1 and 100",
      })
    }

    const data = yield* graphqlRequest(TODOS_QUERY, {
      variables: {
        page: options.page,
        limit: options.limit,
        processPath: options.processPath ?? null,
        status: options.status ?? null,
      },
      errorMessagePrefix: "",
    })
    const response = yield* Schema.decodeUnknown(TodosData)(data).pipe(
      Effect.mapError(
        (cause) =>
          new CliError({
            message: "GraphQL Todo response has an invalid payload",
            cause,
          }),
      ),
    )

    yield* Console.log(JSON.stringify(response.todos.nodes))
  })
