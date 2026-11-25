import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js"
import { Effect, Option, Schema } from "effect"
import type { GraphQLClient } from "graphql-request"

export type ReadToolContext = {
  readonly client: GraphQLClient
  readonly canAct: boolean
  readonly origin: string
}

export type ReadTool = {
  readonly metadata: Tool
  readonly call: (
    context: ReadToolContext,
    input: unknown,
  ) => Promise<CallToolResult>
}

export const toolError = (text: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text }],
})

export const defineReadTool = <A, E>({
  name,
  description,
  args,
  failure,
  read,
}: {
  readonly name: string
  readonly description: string
  readonly args: Schema.Decoder<A>
  readonly failure: string
  readonly read: (
    context: ReadToolContext,
    args: A,
  ) => Effect.Effect<Record<string, unknown>, E>
}): ReadTool => {
  const { schema, definitions } = Schema.toJsonSchemaDocument(args, {
    onExcessProperty: "error",
  })
  return {
    metadata: {
      name,
      description,
      inputSchema: {
        ...schema,
        type: "object",
        ...(Object.keys(definitions).length ? { $defs: definitions } : {}),
      },
      annotations: { readOnlyHint: true },
    },
    call: async (context, input) => {
      const decoded = Schema.decodeUnknownOption(args, {
        onExcessProperty: "error",
      })(input)
      if (Option.isNone(decoded)) return toolError("Invalid tool arguments.")
      return await Effect.runPromise(
        read(context, decoded.value).pipe(
          Effect.match({
            onFailure: () => toolError(failure),
            onSuccess: (data): CallToolResult => ({
              content: [{ type: "text", text: JSON.stringify(data) }],
              structuredContent: data,
            }),
          }),
        ),
      )
    },
  }
}
