import { Match, type Schema } from "effect"
import * as AST from "effect/SchemaAST"
import {
  FormLookupInput,
  fieldAnnotation,
  hasFlattenAnnotation,
  hasStructuralOnlyAnnotation,
  isReadOnlyField,
} from "@pf/form-schema"

/**
 * Recursively removes readonly modifiers from all properties
 */
export type DeepWritable<T> = T extends object
  ? { -readonly [K in keyof T]: DeepWritable<T[K]> }
  : T

/**
 * Generate type-compatible default values from Effect Schema fields.
 *
 * This creates empty/zero values to satisfy Tanstack Form's type requirements.
 * Values are NOT validated - they're just type-compatible placeholders.
 *
 * Without this we have an uncontrolled input error.
 */
export const getSchemaDefaults = <Fields extends Schema.Struct.Fields>(
  fields: Fields,
): { [K in keyof Fields]: DeepWritable<Schema.Schema.Type<Fields[K]>> } => {
  const result: Record<string, unknown> = {}

  for (const [key, fieldSchema] of Object.entries(fields)) {
    const schema = fieldSchema as Schema.Codec<unknown, unknown, never, never>
    // Skip structural-only fields (UI-only elements like TextBlock, Divider)
    if (hasStructuralOnlyAnnotation(schema) || isReadOnlyField(schema)) {
      continue
    }

    if (hasFlattenAnnotation(schema) && schema.ast._tag === "Objects") {
      Object.assign(result, getDefaultsForObjects(schema.ast))
      continue
    }

    const ast = AST.toEncoded(fieldSchema.ast)
    result[key] = getDefaultForSchema(ast, ast.context?.isOptional)
  }

  return result as {
    [K in keyof Fields]: DeepWritable<Schema.Schema.Type<Fields[K]>>
  }
}

const getDefaultsForObjects = (
  typeLiteral: AST.Objects,
): Record<string, unknown> => {
  const result: Record<string, unknown> = {}

  for (const prop of typeLiteral.propertySignatures) {
    const key = String(prop.name)
    const fieldSchema = prop.type as AST.AST
    const fieldAsSchema = { ast: fieldSchema } as Schema.Top

    if (
      hasStructuralOnlyAnnotation(fieldAsSchema) ||
      isReadOnlyField(fieldAsSchema)
    ) {
      continue
    }

    if (fieldSchema._tag === "Objects") {
      if (hasFlattenAnnotation(fieldAsSchema)) {
        Object.assign(result, getDefaultsForObjects(fieldSchema))
        continue
      }
    }

    result[key] = getDefaultForSchema(
      fieldSchema,
      prop.type.context?.isOptional,
    )
  }

  return result
}

const unionMembers = (ast: AST.AST): readonly AST.AST[] =>
  ast._tag === "Union" ? ast.types.flatMap(unionMembers) : [ast]

/**
 * Get default value for a single schema AST node
 */
const getDefaultForSchema = (ast: AST.AST, isOptional = false): unknown => {
  const lookup = fieldAnnotation(ast, FormLookupInput)
  if (
    typeof lookup === "object" &&
    lookup !== null &&
    "mode" in lookup &&
    (lookup.mode === "server" || lookup.mode === "local")
  ) {
    const members = unionMembers(AST.toEncoded(ast))
    if (isOptional || members.some((member) => member._tag === "Undefined"))
      return undefined
    if (members.some((member) => member._tag === "Null")) return null
  }
  const match = Match.type<AST.AST>().pipe(
    Match.tag("String", () => ""),
    Match.tag("Number", () => 0),
    Match.tag("Boolean", () => false),
    Match.tag("Literal", (literal) =>
      isOptional && typeof literal.literal === "string" ? undefined : "",
    ),
    Match.tag("Union", (union) => {
      const members = unionMembers(union)
      if (
        members.some((member) => member._tag === "Boolean") &&
        members.every(
          (member) => member._tag === "Boolean" || member._tag === "Undefined",
        )
      ) {
        return false
      }
      const choices = members.filter(
        (member) => member._tag !== "Undefined" && !(member._tag === "Null"),
      )
      if (
        choices.length > 0 &&
        choices.every(
          (member) =>
            member._tag === "Literal" && typeof member.literal === "string",
        )
      ) {
        if (members.some((member) => member._tag === "Null")) {
          return null
        }
        if (
          isOptional ||
          members.some((member) => member._tag === "Undefined")
        ) {
          return undefined
        }
      }
      return ""
    }),
    Match.tag("Objects", (typeLiteral) => {
      const nestedResult: Record<string, unknown> = {}
      for (const prop of typeLiteral.propertySignatures) {
        nestedResult[String(prop.name)] = getDefaultForSchema(
          prop.type,
          prop.type.context?.isOptional,
        )
      }
      return nestedResult
    }),
    Match.tag("Arrays", () => []),
    Match.orElse(() => ""),
  )

  return match(AST.toEncoded(ast))
}
