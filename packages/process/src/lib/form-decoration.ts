import { Data, Effect, Schema, SchemaAST } from "effect"
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
  mapFormPropertySignature,
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
        if (original.annotations[STRUCTURAL_ONLY_SYMBOL])
          fail(path, "structural fields cannot have defaults")
        // Validate encoded defaults, without executing transformations, services, or refinements here.
        // Full business validation still runs through the submission Effect schema.
        const input = Schema.encodedSchema(Schema.make(original))
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
                      ? Schema.decodeUnknown(lookupResult)(items)
                      : Schema.decodeUnknown(calendarResult)(items),
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
  return SchemaAST.annotations(original, annotations)
}

/** Preserve property transformations and exact field types during safe resolution. */
export const mapFormFields = <Fields extends Schema.Struct.Fields>(
  fields: Fields,
  map: (ast: SchemaAST.AST, name: string) => SchemaAST.AST,
  mapAnnotations: (
    annotations: SchemaAST.Annotations,
    ast: SchemaAST.AST,
    name: string,
    side: "input" | "output",
  ) => SchemaAST.Annotations = (annotations) => annotations,
  // Resolve descriptors retained by Effect on a property's decoded side too.
  mapOutput: (ast: SchemaAST.AST, name: string) => SchemaAST.AST = (ast) => ast,
): Fields => {
  const resolved = Object.fromEntries(
    Object.entries(fields).map(([name, original]) => {
      if (Schema.isPropertySignature(original)) {
        return [
          name,
          mapFormPropertySignature(
            original,
            (ast, side) =>
              side === "input" ? map(ast, name) : mapOutput(ast, name),
            (annotations, input, side) =>
              mapAnnotations(annotations, input, name, side),
          ),
        ]
      }
      return [name, schemaFromAst(map(original.ast, name), original)]
    }),
  )
  // The whitelist preserves every value schema and property contract in Fields.
  return resolved as Fields
}

const sourceStructFields = (
  source: Schema.Struct.Fields[string] | undefined,
): Schema.Struct.Fields | undefined => {
  if (!source || !("fields" in source)) return undefined
  const fields = source.fields
  if (typeof fields !== "object" || fields === null) return undefined
  const result: Record<string, Schema.Struct.Fields[string]> = {}
  for (const [name, field] of Object.entries(fields)) {
    if (!Schema.isSchema(field) && !Schema.isPropertySignature(field))
      return undefined
    result[name] = field
  }
  return result
}

function schemaFromAst(
  ast: SchemaAST.AST,
  source?: Schema.Struct.Fields[string],
): Schema.Schema.Any {
  const sourceFields = sourceStructFields(source)
  const struct =
    ast._tag === "TypeLiteral"
      ? { input: ast, output: ast }
      : ast._tag === "Transformation" &&
          ast.transformation._tag === "TypeLiteralTransformation" &&
          ast.from._tag === "TypeLiteral" &&
          ast.to._tag === "TypeLiteral"
        ? { input: ast.from, output: ast.to }
        : undefined
  if (sourceFields && struct) {
    const inputs = new Map(
      struct.input.propertySignatures.map((p) => [p.name, p]),
    )
    const outputs = new Map(
      struct.output.propertySignatures.map((p) => [p.name, p]),
    )
    const property = (name: string, side: "input" | "output") => {
      const original = sourceFields[name]
      const inputKey =
        Schema.isPropertySignature(original) &&
        original.ast._tag === "PropertySignatureTransformation"
          ? (original.ast.from.fromKey ?? name)
          : name
      const resolved =
        side === "input" ? inputs.get(inputKey) : outputs.get(name)
      if (!resolved)
        return fail(`form.${name}`, "projected struct field is missing")
      return resolved
    }
    // The AST is authoritative for resolved metadata. The original field
    // signatures retain intrinsic defaults, key mappings and decode/encode
    // functions which cannot be reconstructed from a TypeLiteral alone.
    const fields = mapFormFields(
      sourceFields,
      (_ast, name) => property(name, "input").type,
      (annotations, _ast, name, side) =>
        Object.fromEntries(
          Reflect.ownKeys(annotations).map((key) => [
            key,
            property(name, side).annotations[key],
          ]),
        ),
      (_ast, name) => property(name, "output").type,
    )
    return Object.assign(Schema.make(ast), { fields })
  }
  if (ast._tag !== "TypeLiteral") return Schema.make(ast)
  const fields = Object.fromEntries(
    ast.propertySignatures.map((property) => [
      property.name,
      property.isOptional
        ? Schema.optional(schemaFromAst(property.type))
        : schemaFromAst(property.type),
    ]),
  )
  return Object.assign(Schema.make(ast), { fields })
}
