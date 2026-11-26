import { Console, Effect, Schema } from "effect"
import type { HttpClient } from "effect/http"
import { CliError } from "../../errors"
import { graphqlRequest } from "../../utils/graphql-client"

interface RecordInputSources {
  readonly input: string | undefined
  readonly inputFile: string | undefined
  readonly inputStdin: boolean
}

type RecordMutation =
  | { readonly kind: "create"; readonly sources: RecordInputSources }
  | {
      readonly kind: "update"
      readonly id: string
      readonly sources: RecordInputSources
    }
  | { readonly kind: "delete"; readonly id: string }

const Name = Schema.String.check(Schema.isPattern(/^[_A-Za-z][_0-9A-Za-z]*$/))
const TypeName = Schema.String.check(Schema.isPattern(/^[[\]!_0-9A-Za-z]+$/))
interface ResultField {
  readonly name: string
  readonly type: string
  readonly fields?: readonly ResultField[] | undefined
}
const ResultFieldSchema: Schema.Codec<ResultField> = Schema.Struct({
  name: Name,
  type: TypeName,
  fields: Schema.optional(
    Schema.Array(Schema.suspend(() => ResultFieldSchema)),
  ),
})
const OperationSchema = Schema.Struct({
  configured: Schema.Boolean,
  authorized: Schema.Boolean,
  name: Schema.NullOr(Name),
  arguments: Schema.Array(Schema.Struct({ name: Name, type: TypeName })),
  result: Schema.NullOr(ResultFieldSchema),
})
const MetadataSchema = Schema.Struct({
  listMetadata: Schema.NullOr(Schema.Struct({ operation: OperationSchema })),
})

const readInput = (sources: RecordInputSources) =>
  Effect.gen(function* () {
    const count =
      Number(sources.input !== undefined) +
      Number(sources.inputFile !== undefined) +
      Number(sources.inputStdin)
    if (count !== 1)
      return yield* new CliError({
        message:
          "Supply exactly one of --input, --input-file, or --input-stdin.",
      })
    const text =
      sources.input ??
      (yield* Effect.tryPromise({
        try: () =>
          sources.inputFile !== undefined
            ? Bun.file(sources.inputFile).text()
            : Bun.stdin.text(),
        catch: () =>
          new CliError({
            message:
              "Could not read JSON input. Check the input file or stdin.",
          }),
      }))
    return yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
    )(text).pipe(
      Effect.mapError(
        () =>
          new CliError({
            message:
              "Input must be valid JSON containing an object. Check --input, --input-file, or --input-stdin.",
          }),
      ),
    )
  })

const fieldSelection = (depth: number): string =>
  `name type${depth > 0 ? ` fields { ${fieldSelection(depth - 1)} }` : ""}`
const hasUnexpandedFields = (field: ResultField): boolean =>
  field.fields === undefined || field.fields.some(hasUnexpandedFields)
const scalars = new Set([
  "String",
  "ID",
  "Int",
  "Float",
  "Boolean",
  "JSON",
  "DateTime",
  "Date",
])
const resultSelection = (field: ResultField): string => {
  if (field.fields?.length)
    return `{ ${field.fields.map((child) => `${child.name} ${resultSelection(child)}`).join(" ")} }`
  // Recursive object expansion stops in the metadata contract.
  return scalars.has(field.type.replace(/[[\]!]/g, "")) ? "" : "{ __typename }"
}

export const runRecordMutation = (
  path: string,
  mutation: RecordMutation,
): Effect.Effect<void, CliError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const input =
      mutation.kind === "delete"
        ? undefined
        : yield* readInput(mutation.sources)
    let depth = 2
    const discover = () =>
      graphqlRequest(
        `query($path: String!) { listMetadata(listPath: $path) { operation: ${mutation.kind} { configured authorized name arguments { name type } result { ${fieldSelection(depth)} } } } }`,
        { variables: { path } },
      ).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(MetadataSchema)),
        Effect.mapError((error) =>
          error instanceof CliError
            ? error
            : new CliError({
                message:
                  "Invalid List metadata response. Check the organisation API version.",
              }),
        ),
      )
    let metadata = yield* discover()
    while (
      metadata.listMetadata?.operation.result &&
      hasUnexpandedFields(metadata.listMetadata.operation.result)
    ) {
      depth *= 2
      metadata = yield* discover()
    }
    const operation = metadata.listMetadata?.operation
    if (!operation)
      return yield* new CliError({
        message:
          "List not found or not accessible. Check the List path and your view permission.",
      })
    if (!operation.configured || !operation.name)
      return yield* new CliError({
        message: `This List has no authored ${mutation.kind} operation.`,
      })
    if (!operation.authorized)
      return yield* new CliError({
        message: `You are not authorized to ${mutation.kind} records in this List. Ask an administrator for access.`,
      })
    if (!operation.result)
      return yield* new CliError({
        message:
          "List mutation result metadata is missing. Check the organisation API version.",
      })
    const variables: Record<string, unknown> =
      mutation.kind === "create"
        ? { input }
        : mutation.kind === "update"
          ? { id: mutation.id, input }
          : { id: mutation.id }
    const args = operation.arguments.filter((arg) =>
      Object.hasOwn(variables, arg.name),
    )
    if (args.length !== Object.keys(variables).length)
      return yield* new CliError({
        message:
          "List mutation argument metadata is incomplete. Check the organisation API version.",
      })
    const data = yield* graphqlRequest(
      `mutation(${args.map((arg) => `$${arg.name}: ${arg.type}`).join(", ")}) { result: ${operation.name}(${args.map((arg) => `${arg.name}: $${arg.name}`).join(", ")}) ${resultSelection(operation.result)} }`,
      { variables },
    )
    const result = data["result"]
    if (
      (mutation.kind === "create" && typeof result !== "string") ||
      (mutation.kind === "delete" && typeof result !== "boolean") ||
      (mutation.kind === "update" &&
        (result === undefined ||
          (result !== null &&
            (typeof result !== "object" || Array.isArray(result)))))
    ) {
      return yield* new CliError({
        message:
          "Unexpected mutation response. The mutation may have completed; check the record before retrying.",
      })
    }
    yield* Console.log(
      JSON.stringify({
        id: mutation.kind === "create" ? result : mutation.id,
        data: result,
      }),
    )
  })
