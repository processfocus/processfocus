import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import { Data, Effect, Option, Schema } from "effect"
import { ClientError, type GraphQLClient } from "graphql-request"
import { completeListField, fieldsAtDepth } from "./lists"
import {
  type ReadTool,
  type ReadToolContext,
  defineReadTool,
  toolError,
} from "./read-tool"
import { toolData } from "./result"

const FormOperation = Schema.Literals(["create", "update"])
type ListOperation = typeof FormOperation.Type | "delete"

type InputField = {
  readonly name: string
  readonly type: string
  readonly label: string | null
  readonly lookup: boolean
  readonly description: string | null
  readonly required: boolean
  readonly hasDefault: boolean
  readonly defaultValue: unknown
  readonly enumValues: readonly unknown[]
  readonly fields?: readonly InputField[]
}

class ListOperationUnavailable extends Data.TaggedError(
  "ListOperationUnavailable",
) {}

const unavailable =
  "The runtime did not authorize or configure this List operation."
const unknownOutcome = () =>
  toolData({
    status: "unknown",
    message:
      "The List write outcome is unknown. Do not repeat the mutation automatically. A record read can show current state but cannot establish a receipt for this submission.",
  })
const lostResponse =
  "If the reply is lost, use report_lost_list_write; do not repeat the mutation or infer a receipt from a record read."

// Dynamic names and input types come only from the caller's live runtime
// metadata. Model-provided paths, IDs and answers are GraphQL variables.
const writeOperation = Effect.fn("Mcp.listWriteOperation")(function* (
  client: GraphQLClient,
  listPath: string,
  operation: ListOperation,
) {
  for (let depth = 2; ; depth *= 2) {
    const { listMetadata } = yield* Effect.tryPromise(() =>
      client.request<{
        listMetadata: {
          path: string
          name: string
          operation: {
            authorized: boolean
            name: string | null
            arguments: readonly InputField[]
          }
        } | null
      }>(
        `query McpListWriteOperation($listPath: String!) {
          listMetadata(listPath: $listPath) {
            path name
            operation: ${operation} {
              authorized name
              arguments { ${fieldsAtDepth(depth, "name type label lookup description required hasDefault defaultValue enumValues")} }
            }
          }
        }`,
        { listPath },
      ),
    )
    const mutation = listMetadata?.operation
    if (!listMetadata || !mutation?.authorized || !mutation.name)
      return yield* new ListOperationUnavailable()
    if (!mutation.arguments.every(completeListField)) continue
    const input = mutation.arguments.find(({ name }) => name === "input")
    if (operation !== "delete" && !input)
      return yield* new ListOperationUnavailable()
    return {
      path: listMetadata.path,
      listName: listMetadata.name,
      name: mutation.name,
      input,
    }
  }
})

const listPathArg = Schema.NonEmptyString
const idArg = Schema.NonEmptyString.annotate({
  description: "One exact record ID, not a name, filter, or list of IDs.",
})
const inputArg = Schema.JsonObject.annotate({
  description: "Encoded answers from the operation's authored form.",
})
const instructionArg = Schema.Literal(true).annotate({
  description:
    "The person explicitly instructed this exact operation. An unambiguous instruction suffices; do not request redundant confirmation.",
})

const dashboardFormUrl = (origin: string, listPath: string, id?: string) => {
  if (id !== undefined) {
    const url = new URL(`/lists/item/${encodeURIComponent(id)}`, origin)
    url.searchParams.set("list", listPath)
    return url.href
  }
  const path = listPath.split("/").filter(Boolean).map(encodeURIComponent)
  return new URL(`/lists/${path.join("/")}`, origin).href
}

// An optional lookup omitted from the submission need not block other edits.
const needsLookup = (
  fields: readonly InputField[],
  values: unknown,
): boolean => {
  if (Array.isArray(values))
    return values.some((value) => needsLookup(fields, value))
  if (values === null || typeof values !== "object") return false
  return fields.some((field) => {
    const present = Object.hasOwn(values, field.name)
    if (field.lookup && (field.required || present)) return true
    return (
      present &&
      needsLookup(field.fields ?? [], Reflect.get(values, field.name))
    )
  })
}

export const inspectListForm = defineReadTool({
  name: "inspect_list_form",
  description:
    "Read the authored List creation or edit fields, labels, choices, and defaults without submitting. A form with a required lookup must be submitted in the Dashboard, even if the lookup value is unchanged. Use dashboardUrl also when the user wants to change an optional lookup; do not guess or submit partially. For other updates, use inspect_list_record for current values, preserve unchanged required values, and omit unchanged optional fields. Ask for missing answers; do not guess or silently submit defaults.",
  args: Schema.Struct({ listPath: listPathArg, operation: FormOperation }),
  failure: unavailable,
  read: ({ client, origin }, { listPath, operation }) =>
    writeOperation(client, listPath, operation).pipe(
      Effect.map(({ path, listName, input }) => ({
        listPath: path,
        listName,
        operation,
        dashboardUrl: dashboardFormUrl(origin, path),
        fields: input?.fields ?? [],
      })),
    ),
})

const ValidationErrors = Schema.Array(
  Schema.Struct({ field: Schema.String, message: Schema.String }),
)

const rejected = (errors: typeof ValidationErrors.Type) => ({
  ...toolData({ status: "rejected", errors }),
  isError: true,
})

const mutationFailure = (cause: unknown, inputColumn: number) => {
  if (!(cause instanceof ClientError)) return unknownOutcome()
  const { data, errors } = cause.response
  // The runtime can rewrite coercion messages. A request error at the
  // generated $input definition, with no result data or resolver path,
  // happened before execution. Other failures may follow a write.
  if (
    inputColumn > 0 &&
    data === undefined &&
    errors?.length &&
    errors.every(
      (error) =>
        error.path === undefined &&
        error.locations?.length === 1 &&
        error.locations[0]?.line === 1 &&
        error.locations[0].column === inputColumn,
    )
  )
    return rejected([
      {
        field: "",
        message:
          "No record changed. Check required fields, field names and value types in inspect_list_form, then correct the input before resubmitting.",
      },
    ])

  const extensions = errors?.[0]?.extensions
  switch (extensions?.["code"]) {
    case "NotAuthorized":
    case "UNAUTHENTICATED":
      return toolError(unavailable)
    case "InputValidationError": {
      const errors = Schema.decodeUnknownOption(ValidationErrors)(
        extensions["errors"],
      )
      return rejected(Option.getOrElse(errors, () => []))
    }
    default:
      return unknownOutcome()
  }
}

type Submission = {
  readonly listPath: string
} & (
  | { readonly operation: "create"; readonly input: Schema.JsonObject }
  | {
      readonly operation: "update"
      readonly id: string
      readonly input: Schema.JsonObject
    }
  | { readonly operation: "delete"; readonly id: string }
)

const submitListWrite = (
  { client, origin }: ReadToolContext,
  submission: Submission,
) =>
  writeOperation(client, submission.listPath, submission.operation).pipe(
    Effect.matchEffect({
      onFailure: () => Effect.succeed(toolError(unavailable)),
      onSuccess: ({ path: listPath, name, input }) => {
        const variables: Record<string, unknown> = {}
        const definitions: string[] = []
        const args: string[] = []
        if ("id" in submission) {
          variables["id"] = submission.id
          definitions.push("$id: String!")
          args.push("id: $id")
        }
        if ("input" in submission) {
          if (!input) return Effect.succeed(toolError(unavailable))
          if (needsLookup(input.fields ?? [], submission.input))
            return Effect.succeed(
              toolData({
                status: "dashboard_required",
                dashboardUrl: dashboardFormUrl(
                  origin,
                  listPath,
                  "id" in submission ? submission.id : undefined,
                ),
                message:
                  "No record changed. Use the authored lookup in the Dashboard form.",
              }),
            )
          variables["input"] = submission.input
          definitions.push(`$input: ${input.type}`)
          args.push("input: $input")
        }
        const selection =
          submission.operation === "update" ? " { __typename }" : ""
        const document = `mutation McpWriteListRecord(${definitions.join(", ")}) {
          result: ${name}(${args.join(", ")})${selection}
        }`
        return Effect.tryPromise({
          try: () => client.request<{ result: unknown }>(document, variables),
          catch: (cause) => cause,
        }).pipe(
          Effect.match({
            onFailure: (cause) =>
              mutationFailure(cause, document.indexOf("$input") + 1),
            onSuccess: ({ result }) => {
              switch (submission.operation) {
                case "create":
                  return typeof result === "string" && result.length > 0
                    ? toolData({
                        status: "created",
                        listPath,
                        id: result,
                        message:
                          "A List record was created. No Process was started.",
                      })
                    : unknownOutcome()
                case "update":
                  return result &&
                    typeof result === "object" &&
                    "__typename" in result
                    ? toolData({
                        status: "updated",
                        listPath,
                        id: submission.id,
                      })
                    : unknownOutcome()
                case "delete":
                  return result === true
                    ? toolData({
                        status: "deleted",
                        listPath,
                        id: submission.id,
                      })
                    : unknownOutcome()
              }
            },
          }),
        )
      },
    }),
  )

const defineListWrite = <A>({
  name,
  description,
  destructiveHint,
  args,
  submission,
}: {
  name: string
  description: string
  destructiveHint: boolean
  args: Schema.Decoder<A>
  submission: (args: A) => Submission
}): ReadTool => {
  const { schema, definitions } = Schema.toJsonSchemaDocument(args, {
    onExcessProperty: "error",
  })
  const metadata: Tool = {
    name,
    description: `${description} ${lostResponse}`,
    inputSchema: {
      ...schema,
      type: "object",
      ...(Object.keys(definitions).length ? { $defs: definitions } : {}),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint,
      idempotentHint: false,
    },
  }
  return {
    metadata,
    call: (context, input) => {
      if (!context.canAct)
        return Promise.resolve(
          toolError(
            "This connection has View work access and cannot change List records.",
          ),
        )
      const decoded = Schema.decodeUnknownOption(args, {
        onExcessProperty: "error",
      })(input)
      if (Option.isNone(decoded))
        return Promise.resolve(
          toolError(
            "Invalid tool arguments. Use one exact target for edit or delete and an explicit user instruction.",
          ),
        )
      return Effect.runPromise(
        submitListWrite(context, submission(decoded.value)),
      )
    },
  }
}

const writeArgs = { listPath: listPathArg, confirmed: instructionArg }

export const listWriteTools = [
  defineListWrite({
    name: "create_list_record",
    description:
      "Create a record directly, not a Process Execution. If a request could mean either action, clarify first. Use inspect_list_form with operation create and submit only when explicitly instructed.",
    destructiveHint: false,
    args: Schema.Struct({ ...writeArgs, input: inputArg }),
    submission: (args) => ({ ...args, operation: "create" }),
  }),
  defineListWrite({
    name: "update_list_record",
    description:
      "Edit one explicitly identified List record. Use inspect_list_form with operation update. Change only the fields the person specified.",
    destructiveHint: true,
    args: Schema.Struct({ ...writeArgs, id: idArg, input: inputArg }),
    submission: (args) => ({ ...args, operation: "update" }),
  }),
  defineListWrite({
    name: "delete_list_record",
    description:
      "Delete one explicitly identified List record by exact ID. If a name or filter matches several records, show the candidates and ask which one; never select one arbitrarily. An unambiguous instruction to delete this record needs no separate confirmation.",
    destructiveHint: true,
    args: Schema.Struct({ ...writeArgs, id: idArg }),
    submission: (args) => ({ ...args, operation: "delete" }),
  }),
]

export const reportLostListWrite: ReadTool = {
  metadata: {
    name: "report_lost_list_write",
    description:
      "Report an unknown outcome when a List create, edit, or delete reply was lost. This performs no mutation or lookup: List writes do not have a recoverable receipt.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  call: () => Promise.resolve(unknownOutcome()),
}
