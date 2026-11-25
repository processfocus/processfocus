import { Data, Effect, Schema, type SchemaAST } from "effect"
import {
  CurrentProviderUser,
  FormAutoComplete,
  FormCalendarSlotInput,
  FormDefault,
  FormDescription,
  FormLabel,
  FormLookupInput,
  FormProviderUserInput,
  STRUCTURAL_ONLY_SYMBOL,
  fieldAnnotation,
} from "@pf/form-schema"

export class FormDecorationError extends Data.TaggedError(
  "FormDecorationError",
)<{
  readonly path: string
  readonly message: string
}> {}

const fail = (path: string, message: string): never => {
  throw new FormDecorationError({ path, message: `${path}: ${message}` })
}

const record = (value: unknown, path: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(path, "expected a decoration object")
  }
  if (Object.getOwnPropertySymbols(value).length)
    fail(path, "symbol operations are not supported")
  return value as Record<string, unknown>
}

const lookupResult = Schema.Array(
  Schema.Struct({ value: Schema.String, label: Schema.String }),
)
const calendarResult = Schema.Array(
  Schema.Struct({
    value: Schema.String,
    startsAt: Schema.String,
    endsAt: Schema.String,
    label: Schema.optional(Schema.String),
  }),
)

export const decorateAst = (
  original: SchemaAST.AST,
  value: unknown,
  path: string,
  inputAst: SchemaAST.AST = original,
): SchemaAST.AST => {
  const operations = record(value, path)
  const annotations: Record<symbol, unknown> = {}
  for (const [key, operation] of Object.entries(operations)) {
    if (
      !["label", "description", "autoComplete", "default", "query"].includes(
        key,
      )
    )
      fail(path, `unsupported operation ${key}`)
    if (operation === undefined) continue
    switch (key) {
      case "label":
      case "description":
      case "autoComplete": {
        if (typeof operation !== "string") fail(path, `${key} must be text`)
        annotations[
          key === "label"
            ? FormLabel
            : key === "description"
              ? FormDescription
              : FormAutoComplete
        ] = operation
        break
      }
      case "default": {
        if (fieldAnnotation(original, STRUCTURAL_ONLY_SYMBOL))
          fail(path, "structural fields cannot have defaults")
        // Validate encoded defaults, without executing transformations, services, or refinements here.
        // Full business validation still runs through the submission Effect schema.
        const input = Schema.toEncoded(Schema.make(inputAst))
        const checked = (candidate: unknown): unknown => {
          if (
            !(
              candidate === CurrentProviderUser &&
              fieldAnnotation(original, FormProviderUserInput) === true
            ) &&
            !Schema.is(input)(candidate)
          )
            fail(path, "default does not match the declared input type")
          return candidate
        }
        annotations[FormDefault] = checked(
          typeof operation === "function" ? operation() : operation,
        )
        break
      }
      case "query": {
        if (typeof operation !== "function")
          fail(path, "query must be a function")
        const query = operation as (...args: unknown[]) => unknown
        const lookup = fieldAnnotation(original, FormLookupInput)
        const calendar = fieldAnnotation(original, FormCalendarSlotInput)
        if (!lookup && !calendar)
          fail(path, "query requires a declared lookup or calendar field")
        const metadata = lookup ?? calendar
        if (typeof metadata !== "object" || metadata === null)
          fail(path, "invalid query declaration")
        annotations[lookup ? FormLookupInput : FormCalendarSlotInput] = {
          ...(metadata as object),
          query: (...args: unknown[]) =>
            Effect.suspend(() => {
              const result = query(...args)
              if (!Effect.isEffect(result))
                return Effect.fail(
                  new FormDecorationError({
                    path,
                    message: "query must return an Effect",
                  }),
                )
              return result.pipe(
                Effect.flatMap(
                  (items): Effect.Effect<unknown, unknown> =>
                    lookup
                      ? Schema.decodeUnknownEffect(lookupResult)(items)
                      : Schema.decodeUnknownEffect(calendarResult)(items),
                ),
              )
            }),
        }
        break
      }
      default:
        fail(path, `unsupported operation ${key}`)
    }
  }
  return Schema.make<Schema.Top>(
    Object.assign(Object.create(Object.getPrototypeOf(original)), original, {
      annotations: { ...original.annotations, ...annotations },
    }),
  ).annotate(annotations).ast
}

/** Preserve property transformations and exact field types during safe resolution. */
export const mapFormFields = <Fields extends Schema.Struct.Fields>(
  fields: Fields,
  map: (ast: SchemaAST.AST, name: string) => SchemaAST.AST,
  mapAnnotations: (
    annotations: Record<PropertyKey, unknown>,
    ast: SchemaAST.AST,
    name: string,
    side: "input" | "output",
  ) => Record<PropertyKey, unknown> = (annotations) => annotations,
  // Resolve descriptors retained by Effect on a property's decoded side too.
  mapOutput: (ast: SchemaAST.AST, name: string) => SchemaAST.AST = (ast) => ast,
): Fields => {
  const resolved = Object.fromEntries(
    Object.entries(fields).map(([name, original]) => {
      const mapped = map(original.ast, name)
      const annotations = mapAnnotations(
        { ...mapped.annotations },
        mapped,
        name,
        "input",
      )
      const output = mapped.encoding ? mapOutput(mapped, name) : mapped
      return [
        name,
        schemaFromAst(
          Schema.make<Schema.Top>(output).annotate(annotations).ast,
          original,
        ),
      ]
    }),
  )
  // The whitelist preserves every value schema and property contract in Fields.
  return resolved as unknown as Fields
}

const sourceStructFields = (
  source: Schema.Struct.Fields[string] | undefined,
): Schema.Struct.Fields | undefined => {
  if (!source || !("fields" in source)) return undefined
  const fields = source.fields
  if (typeof fields !== "object" || fields === null) return undefined
  const result: Record<string, Schema.Struct.Fields[string]> = {}
  for (const [name, field] of Object.entries(fields)) {
    if (!Schema.isSchema(field)) return undefined
    result[name] = field
  }
  return result
}

function schemaFromAst(
  ast: SchemaAST.AST,
  source?: Schema.Struct.Fields[string],
): Schema.Top {
  const sourceFields = sourceStructFields(source)
  if (ast._tag !== "Objects") return Schema.make<Schema.Top>(ast)
  const fields = Object.fromEntries(
    ast.propertySignatures.map((property) => [
      property.name,
      schemaFromAst(property.type, sourceFields?.[property.name]),
    ]),
  )
  return Object.assign(Schema.make<Schema.Top>(ast), { fields })
}
