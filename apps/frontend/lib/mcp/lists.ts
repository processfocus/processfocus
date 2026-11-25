import { Data, Effect, Option, Schema } from "effect"
import type { GraphQLClient } from "graphql-request"
import { defineReadTool } from "./read-tool"
import { graphql } from "@/lib/generated/gql"

const catalog = graphql(`
  query McpLists {
    availableLists { path name purpose }
  }
`)

const capabilities = graphql(`
  query McpListCapabilities($path: String!) {
    listMetadata(listPath: $path) {
      path
      name
      browse { configured authorized }
      detail { configured authorized }
      create { configured authorized }
      update { configured authorized }
      delete { configured authorized }
      configuredProcessStartCount
      authorizedProcessStarts { path name startStepPath }
    }
  }
`)

export class ListUnavailable extends Data.TaggedError("ListUnavailable") {}

const PageNumber = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 2147483647 }),
)
const SourcePage = Schema.Struct({
  page: PageNumber,
  filter: Schema.optionalKey(Schema.String),
})
export const ListStartContext = Schema.Struct({
  listPath: Schema.NonEmptyString,
  recordId: Schema.optionalKey(Schema.NonEmptyString),
  sourcePage: Schema.optionalKey(SourcePage),
})

const listCapabilities = (client: GraphQLClient, path: string) =>
  Effect.tryPromise(() => client.request(capabilities, { path })).pipe(
    Effect.flatMap(({ listMetadata }) =>
      listMetadata ? Effect.succeed(listMetadata) : new ListUnavailable(),
    ),
  )

const ListArgs = Schema.Struct({ listPath: Schema.NonEmptyString })
const failure = "The List or requested operation is unknown or unavailable."
const listLists = defineReadTool({
  name: "list_lists",
  description: "Discover Lists visible to you and their exact paths.",
  args: Schema.Struct({}).check(Schema.isMaxProperties(0)),
  failure: "The runtime did not return the visible Lists.",
  read: ({ client }) =>
    Effect.tryPromise(() => client.request(catalog)).pipe(
      Effect.map(({ availableLists }) => ({ lists: availableLists })),
    ),
})

const describeList = defineReadTool({
  name: "describe_list",
  description:
    "Find permitted related Process starts separately from direct List record creation. If both are plausible, ask which the user wants before any write. For a chosen related start, pass its path and the List context to get_process_start_form. No writes are performed.",
  args: ListArgs,
  failure,
  read: ({ client, canAct }, { listPath }) =>
    Effect.gen(function* () {
      const list = yield* listCapabilities(client, listPath)
      const action = (op: { configured: boolean; authorized: boolean }) => ({
        configured: op.configured,
        runtimeAuthorized: op.authorized,
        permitted: canAct && op.authorized,
      })
      return {
        path: list.path,
        name: list.name,
        actions: {
          browse: {
            configured: list.browse.configured,
            permitted: list.browse.authorized,
          },
          inspect: {
            configured: list.detail.configured,
            permitted: list.detail.authorized,
          },
          createRecord: action(list.create),
          updateRecord: action(list.update),
          deleteRecord: action(list.delete),
          relatedProcessStarts: {
            configuredCount: list.configuredProcessStartCount,
            runtimeAuthorized: list.authorizedProcessStarts,
            permitted: canAct ? list.authorizedProcessStarts : [],
          },
        },
      }
    }),
})

// Only the runtime's output projection supplies field names. Tool inputs
// supply variable values, never a GraphQL operation or selection.
type Field = {
  readonly name: string
  readonly type: string
  readonly fields?: readonly Field[]
}
export const fieldsAtDepth = (
  depth: number,
  attributes = "name type",
): string =>
  `${attributes} ${depth > 0 ? `fields { ${fieldsAtDepth(depth - 1, attributes)} }` : ""}`
export const completeListField = (field: Field): boolean =>
  field.fields?.every(completeListField) ?? false
const selection = (field: Field, ancestors: readonly string[] = []): string => {
  const namedType = field.type.replace(/[[\]!]/g, "")
  if (!field.fields?.length)
    return ancestors.includes(namedType) ? " { __typename }" : ""
  return ` { ${field.fields.map((child) => `${child.name}${selection(child, [...ancestors, namedType])}`).join(" ")} }`
}

const readRecords = Effect.fn("Mcp.readListRecords")(function* (
  client: GraphQLClient,
  path: string,
  read:
    | { kind: "browse"; page: number; filter: string | undefined }
    | { kind: "detail"; id: string },
) {
  for (let depth = 2; ; depth *= 2) {
    const { listMetadata } = yield* Effect.tryPromise(() =>
      client.request<{
        listMetadata: {
          operation: { name: string | null; result: Field | null }
        } | null
      }>(
        `query McpListProjection($path: String!) {
          listMetadata(listPath: $path) {
            operation: ${read.kind} { name result { ${fieldsAtDepth(depth)} } }
          }
        }`,
        { path },
      ),
    )
    const { name, result } = listMetadata?.operation ?? {}
    if (!name || !result) return yield* new ListUnavailable()
    if (!completeListField(result)) continue
    const args =
      read.kind === "browse"
        ? {
            definitions: "$page: Int!, $filter: String",
            arguments: "page: $page, filter: $filter",
            variables: { page: read.page, filter: read.filter },
          }
        : {
            definitions: "$id: String!",
            arguments: "id: $id",
            variables: { id: read.id },
          }
    const data = yield* Effect.tryPromise(() =>
      client.request<{ result: unknown }>(
        `query McpReadList(${args.definitions}) {
          result: ${name}(${args.arguments})${selection(result)}
        }`,
        args.variables,
      ),
    )
    if (data.result === undefined) return yield* new ListUnavailable()
    return data.result
  }
})

export const resolveListStartContext = Effect.fn("Mcp.resolveListStartContext")(
  function* (
    client: GraphQLClient,
    context: typeof ListStartContext.Type,
    processPath: string,
    startStepPath: string,
  ) {
    const list = yield* listCapabilities(client, context.listPath)
    if (
      !list.authorizedProcessStarts.some(
        (start) =>
          start.path === processPath && start.startStepPath === startStepPath,
      )
    )
      return yield* new ListUnavailable()

    const listContext = { listPath: list.path, listName: list.name }
    if (context.recordId === undefined) return listContext
    const { recordId, sourcePage } = context
    if (list.detail.authorized) {
      const record = yield* readRecords(client, list.path, {
        kind: "detail",
        id: recordId,
      })
      if (record === null) return yield* new ListUnavailable()
      return { ...listContext, recordId, record }
    }

    if (!sourcePage) return yield* new ListUnavailable()
    // If detail is unavailable, recheck the exact row
    // against one authorized page, not a caller snapshot or a full scan.
    const page = yield* readRecords(client, list.path, {
      kind: "browse",
      page: sourcePage.page,
      filter: sourcePage.filter,
    })
    const decoded = Schema.decodeUnknownOption(
      Schema.Struct({ items: Schema.Array(Schema.Unknown) }),
    )(page)
    if (Option.isNone(decoded)) return yield* new ListUnavailable()
    const matches = decoded.value.items.filter(
      (row) =>
        typeof row === "object" &&
        row !== null &&
        "id" in row &&
        (typeof row.id === "string" || typeof row.id === "number") &&
        String(row.id) === recordId,
    )
    const [record] = matches
    if (matches.length !== 1) return yield* new ListUnavailable()
    return { ...listContext, recordId, sourcePage, record }
  },
)

const browseList = defineReadTool({
  name: "browse_list",
  description:
    "Browse a List by path with its optional text filter. Start at page 1 and continue while hasNextPage is true. When several records match, show their IDs and distinguishing fields and ask the user to choose. Keep the returned sourcePage for a related start when List detail is unavailable.",
  args: Schema.Struct({
    ...ListArgs.fields,
    page: Schema.optionalKey(PageNumber),
    filter: Schema.optionalKey(Schema.String),
  }),
  failure,
  read: ({ client }, { listPath, page = 1, filter }) =>
    readRecords(client, listPath, {
      kind: "browse",
      page,
      filter,
    }).pipe(
      Effect.map((records) => ({
        listPath,
        records,
        sourcePage: { page, ...(filter === undefined ? {} : { filter }) },
      })),
    ),
})

const inspectRecord = defineReadTool({
  name: "inspect_list_record",
  description:
    "Inspect one List record by exact ID (use browse_list to find it). A null record means no detail was returned for that ID. Do not guess an ID from a name.",
  args: Schema.Struct({ ...ListArgs.fields, id: Schema.NonEmptyString }),
  failure,
  read: ({ client }, { listPath, id }) =>
    readRecords(client, listPath, { kind: "detail", id }).pipe(
      Effect.map((record) => ({ listPath, id, record })),
    ),
})

export const listTools = [listLists, describeList, browseList, inspectRecord]
