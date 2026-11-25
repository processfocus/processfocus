import { Effect, Schema } from "effect"
import type { HttpClient } from "effect/http"
import { CliError } from "../errors"
import { graphqlRequest } from "./graphql-client"

const fieldProperties = {
  name: Schema.String,
  type: Schema.String,
  required: Schema.Boolean,
  description: Schema.NullOr(Schema.String),
  enumValues: Schema.Array(Schema.Unknown),
  hasDefault: Schema.Boolean,
  defaultValue: Schema.Unknown,
}
interface Field extends Schema.Struct.Type<typeof fieldProperties> {
  readonly fields?: readonly Field[] | undefined
}
const FieldSchema: Schema.Codec<Field> = Schema.Struct({
  ...fieldProperties,
  fields: Schema.optional(Schema.Array(Schema.suspend(() => FieldSchema))),
})
const OperationSchema = Schema.Struct({
  configured: Schema.Boolean,
  authorized: Schema.Boolean,
  name: Schema.NullOr(Schema.String),
  arguments: Schema.Array(FieldSchema),
  result: Schema.NullOr(FieldSchema),
})
const MetadataSchema = Schema.Struct({
  path: Schema.String,
  name: Schema.String,
  sortableFields: Schema.Array(Schema.String),
  browse: OperationSchema,
  detail: OperationSchema,
  create: OperationSchema,
  update: OperationSchema,
  delete: OperationSchema,
})
export type ListMetadata = typeof MetadataSchema.Type
export type ListOperation = typeof OperationSchema.Type

const fieldSelection = (depth: number): string =>
  `name type required description enumValues hasDefault defaultValue ${depth > 0 ? `fields { ${fieldSelection(depth - 1)} }` : ""}`
const completeField = (field: Field): boolean =>
  field.fields?.every(completeField) ?? false

export const getListMetadata = (
  path: string,
): Effect.Effect<ListMetadata, CliError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    // Expand until every metadata branch ends, rather than truncating nested forms.
    for (let depth = 2; ; depth *= 2) {
      const operation = `configured authorized name arguments { ${fieldSelection(depth)} } result { ${fieldSelection(depth)} }`
      const data = yield* graphqlRequest(
        `query DescribeList($path: String!) {
        listMetadata(listPath: $path) { path name sortableFields
          browse { ${operation} } detail { ${operation} }
          create { ${operation} } update { ${operation} } delete { ${operation} }
        }
      }`,
        { variables: { path } },
      )
      if (data["listMetadata"] === null) {
        return yield* new CliError({
          code: "LIST_UNAVAILABLE",
          message:
            "List is unknown or inaccessible. Run pforg lists list for accessible paths.",
        })
      }
      const metadata = yield* Schema.decodeUnknownEffect(MetadataSchema)(
        data["listMetadata"],
      ).pipe(
        Effect.mapError(
          () =>
            new CliError({
              code: "INVALID_RESPONSE",
              message:
                "Invalid List metadata response. Check that the organisation API supports List discovery.",
            }),
        ),
      )
      if (
        [
          metadata.browse,
          metadata.detail,
          metadata.create,
          metadata.update,
          metadata.delete,
        ].every(
          (op) =>
            op.arguments.every(completeField) &&
            (op.result === null || completeField(op.result)),
        )
      )
        return metadata
    }
  })

export const requireListOperation = (
  metadata: ListMetadata,
  operation: "browse" | "detail" | "create" | "update" | "delete",
): Effect.Effect<
  ListOperation & { readonly name: string; readonly result: Field },
  CliError
> => {
  const capability = metadata[operation]
  if (!capability.configured)
    return Effect.fail(
      new CliError({
        code: "OPERATION_UNAVAILABLE",
        message: `This List does not expose ${operation}. Run pforg lists describe ${metadata.path} for available operations.`,
      }),
    )
  if (!capability.authorized)
    return Effect.fail(
      new CliError({
        code: "PERMISSION_DENIED",
        message: `You are not authorized to ${operation} this List. Ask an administrator for access.`,
      }),
    )
  if (!capability.name || !capability.result)
    return Effect.fail(
      new CliError({
        code: "INVALID_RESPONSE",
        message:
          "Authorized List operation is missing its schema. Check the organisation API version.",
      }),
    )
  return Effect.succeed({
    ...capability,
    name: capability.name,
    result: capability.result,
  })
}

export const resultSelection = (
  field: Field,
  ancestors: readonly string[] = [],
): string => {
  const namedType = field.type.replace(/[[\]!]/g, "")
  if (!field.fields?.length)
    return ancestors.includes(namedType) ? " { __typename }" : ""
  return ` { ${field.fields.map((child) => `${child.name}${resultSelection(child, [...ancestors, namedType])}`).join(" ")} }`
}
