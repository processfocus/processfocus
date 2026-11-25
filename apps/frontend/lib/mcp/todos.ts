import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js"
import { Effect, Option, Schema } from "effect"
import { ClientError, type GraphQLClient } from "graphql-request"
import { type ReadTool, defineReadTool, toolError } from "./read-tool"
import { graphql } from "@/lib/generated/gql"
import { toUrlPath } from "@/lib/utils"

const todos = graphql(`
  query McpActionableTodos($page: Int!, $status: String!) {
    todos(page: $page, limit: 25, status: $status) {
      page
      hasNextPage
      nodes {
        id
        processExecutionId
        processName
        stepName
        status
        priority
        dueAt
        description
        summary { label value }
      }
    }
  }
`)

const ToolArguments = Schema.Struct({
  page: Schema.optionalKey(
    Schema.Int.pipe(
      Schema.check(Schema.isBetween({ minimum: 1, maximum: 2147483647 })),
    ),
  ),
  status: Schema.optionalKey(
    Schema.Literals(["Active", "Correction Required"]),
  ),
})

export const listMyTodos = defineReadTool({
  name: "list_my_todos",
  description:
    "List actionable To-Dos for the signed-in person. Start at page 1 and continue while hasNextPage is true. Set status to Correction Required to list public invitation corrections instead.",
  args: ToolArguments,
  failure: "The runtime did not authorize or return the To-Dos.",
  read: ({ client }, { page, status }) =>
    Effect.tryPromise(() =>
      client.request(todos, { page: page ?? 1, status: status ?? "Active" }),
    ).pipe(Effect.map((result) => result.todos)),
})

const todoForm = graphql(`
  query McpTodoForm($todoId: ID!, $answers: JSON!) {
    todoChatForm(todoId: $todoId, answers: $answers)
  }
`)

const completeTodo = graphql(`
  mutation McpCompleteTodo($todoId: ID!, $answers: JSON!) {
    completeTodoFromChat(todoId: $todoId, answers: $answers) {
      executionId
      stepPath
    }
  }
`)

const formArgs = {
  todoId: Schema.NonEmptyString,
  answers: Schema.optionalKey(
    Schema.JsonObject.annotate({
      description:
        "Authored field names and encoded values. Use nested objects for nested paths.",
    }),
  ),
}

const RuntimeForm = Schema.StructWithRest(
  Schema.Struct({ stepPath: Schema.String, needsDashboard: Schema.Boolean }),
  [Schema.JsonObject],
)

const readForm = (
  { client, origin }: { client: GraphQLClient; origin: string },
  todoId: string,
  answers: Schema.JsonObject,
) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise(() =>
      client.request(todoForm, { todoId, answers }),
    )
    const form = yield* Schema.decodeUnknownEffect(RuntimeForm)(
      response.todoChatForm,
    )
    const path = toUrlPath(form.stepPath)
      .split("/")
      .map(encodeURIComponent)
      .join("/")
    const url = new URL(`/to-dos/complete/${path}`, origin)
    url.searchParams.set("todoId", todoId)
    return {
      ...form,
      dashboardUrl: url.href,
      validationBasis:
        "Only the supplied answers and authored defaults were checked. If any answer was not passed to this call or has changed, inspect again with all known answers before deciding what is missing.",
    }
  })

export const inspectTodoForm = defineReadTool({
  name: "inspect_todo_form",
  description:
    "Read and validate the exact To-Do's form without submitting. The result reflects only the answers passed to this call plus authored defaults. After mapping the person's answers to field names, call again with all known answers before deciding the form is complete: an answer can reveal new required fields. Use the authored labels and choices. Ask for missing or invalid business answers; do not guess. If needsDashboard is true, give the exact dashboardUrl and say the To-Do remains open.",
  args: Schema.Struct(formArgs),
  failure: "The runtime did not authorize or return this open To-Do form.",
  read: (context, { todoId, answers }) =>
    readForm(context, todoId, answers ?? {}),
})

const CompleteArguments = Schema.Struct({
  todoId: formArgs.todoId,
  answers: Schema.JsonObject,
  confirmed: Schema.Literal(true),
})

const ValidationErrors = Schema.Array(
  Schema.Struct({ field: Schema.String, message: Schema.String }),
)

const result = (
  data: Record<string, unknown>,
  isError = false,
): CallToolResult => ({
  ...(isError ? { isError: true } : {}),
  content: [{ type: "text", text: JSON.stringify(data) }],
  structuredContent: data,
})

const completeMetadata = {
  name: "complete_todo",
  description:
    "Complete one exact To-Do only after the person explicitly asks you to submit it. Inspect the form with the proposed answers first. Ask for missing business answers and hand off unsupported required fields to the Dashboard. If the response is lost, retry only with the same To-Do and unchanged answers as the same caller.",
  inputSchema: {
    type: "object",
    properties: {
      todoId: {
        type: "string",
        description: "Exact To-Do ID from list_my_todos.",
      },
      answers: {
        type: "object",
        description:
          "Authored field names and encoded values. Use nested objects for nested paths.",
      },
      confirmed: {
        type: "boolean",
        const: true,
        description:
          "The person explicitly instructed you to submit this To-Do.",
      },
    },
    required: ["todoId", "answers", "confirmed"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, idempotentHint: true },
} satisfies Tool

export const completeTodoTool = {
  metadata: completeMetadata,
  call: async (context, input) => {
    if (!context.canAct)
      return toolError(
        "This connection has View work access and cannot complete To-Dos.",
      )
    const args = Schema.decodeUnknownOption(CompleteArguments)(input)
    if (Option.isNone(args))
      return toolError(
        "Supply the To-Do ID, answers, and the person's explicit confirmation.",
      )
    const { todoId, answers } = args.value
    return Effect.runPromise(
      Effect.tryPromise({
        try: () => context.client.request(completeTodo, { todoId, answers }),
        catch: (cause) => cause,
      }).pipe(
        Effect.map(({ completeTodoFromChat: completion }) =>
          result({
            status: "completed",
            todoId,
            ...completion,
            executionUrl: new URL(
              `/executions/${encodeURIComponent(completion.executionId)}`,
              context.origin,
            ).href,
          }),
        ),
        Effect.catch((cause) => {
          const extensions =
            cause instanceof ClientError
              ? cause.response.errors?.[0]?.extensions
              : undefined
          switch (extensions?.["code"]) {
            case "NotAuthorized":
            case "UNAUTHENTICATED":
              return Effect.succeed(
                toolError(
                  "The runtime did not authorize this To-Do completion.",
                ),
              )
            case "StepCompletionConflictError":
              return Effect.succeed(
                toolError(
                  "The runtime could not confirm completion for these answers. Do not claim they were accepted. Check the To-Do in Process Focus.",
                ),
              )
            case "InputValidationError": {
              const errors = Schema.decodeUnknownOption(ValidationErrors)(
                extensions["errors"],
              )
              const rejected = {
                status: "rejected",
                errors: Option.getOrElse(errors, () => []),
              }
              return readForm(context, todoId, answers).pipe(
                Effect.map((form) => result({ ...form, ...rejected }, true)),
                Effect.catch(() => Effect.succeed(result(rejected, true))),
              )
            }
            default:
              return Effect.succeed(
                toolError(
                  "Completion is unconfirmed. To recover, retry only this exact To-Do and unchanged answers as the same caller.",
                ),
              )
          }
        }),
      ),
    )
  },
} satisfies ReadTool
