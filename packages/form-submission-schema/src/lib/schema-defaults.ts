import { Match, type Schema } from "effect"
import type * as AST from "effect/SchemaAST"
import {
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
    const schema = fieldSchema as Schema.Schema<unknown, unknown, never>
    // Skip structural-only fields (UI-only elements like TextBlock, Divider)
    if (hasStructuralOnlyAnnotation(schema) || isReadOnlyField(schema)) {
      continue
    }

    if (hasFlattenAnnotation(schema) && schema.ast._tag === "TypeLiteral") {
      Object.assign(result, getDefaultsForTypeLiteral(schema.ast))
      continue
    }

    const ast = fieldSchema.ast
    if (ast._tag === "PropertySignatureDeclaration") {
      result[key] = getDefaultForSchema(ast.type, ast.isOptional)
    } else if (ast._tag === "PropertySignatureTransformation") {
      result[key] = getDefaultForSchema(ast.from.type, ast.from.isOptional)
    } else {
      result[key] = getDefaultForSchema(ast)
    }
  }

  return result as {
    [K in keyof Fields]: DeepWritable<Schema.Schema.Type<Fields[K]>>
  }
}

const getDefaultsForTypeLiteral = (
  typeLiteral: AST.TypeLiteral,
): Record<string, unknown> => {
  const result: Record<string, unknown> = {}

  for (const prop of typeLiteral.propertySignatures) {
    const key = String(prop.name)
    const fieldSchema = prop.type as AST.AST
    const fieldAsSchema = { ast: fieldSchema } as Schema.Schema.Any

    if (
      hasStructuralOnlyAnnotation(fieldAsSchema) ||
      isReadOnlyField(fieldAsSchema)
    ) {
      continue
    }

    if (fieldSchema._tag === "TypeLiteral") {
      if (hasFlattenAnnotation(fieldAsSchema)) {
        Object.assign(result, getDefaultsForTypeLiteral(fieldSchema))
        continue
      }
    }

    result[key] = getDefaultForSchema(fieldSchema, prop.isOptional)
  }

  return result
}

const unionMembers = (ast: AST.AST): readonly AST.AST[] =>
  ast._tag === "Union" ? ast.types.flatMap(unionMembers) : [ast]

/**
 * Get default value for a single schema AST node
 */
const getDefaultForSchema = (ast: AST.AST, isOptional = false): unknown => {
  const match = Match.type<AST.AST>().pipe(
    Match.tag("StringKeyword", () => ""),
    Match.tag("NumberKeyword", () => 0),
    Match.tag("BooleanKeyword", () => false),
    Match.tag("Refinement", (refinement) =>
      getDefaultForSchema(refinement.from, isOptional),
    ),
    Match.tag("Transformation", (transformation) =>
      getDefaultForSchema(transformation.from, isOptional),
    ),
    Match.tag("Literal", (literal) =>
      isOptional && typeof literal.literal === "string" ? undefined : "",
    ),
    Match.tag("Union", (union) => {
      const members = unionMembers(union)
      const choices = members.filter(
        (member) =>
          member._tag !== "UndefinedKeyword" &&
          !(member._tag === "Literal" && member.literal === null),
      )
      if (
        choices.length > 0 &&
        choices.every(
          (member) =>
            member._tag === "Literal" && typeof member.literal === "string",
        )
      ) {
        if (
          members.some(
            (member) => member._tag === "Literal" && member.literal === null,
          )
        ) {
          return null
        }
        if (
          isOptional ||
          members.some((member) => member._tag === "UndefinedKeyword")
        ) {
          return undefined
        }
      }
      return ""
    }),
    Match.tag("TypeLiteral", (typeLiteral) => {
      const nestedResult: Record<string, unknown> = {}
      for (const prop of typeLiteral.propertySignatures) {
        nestedResult[String(prop.name)] = getDefaultForSchema(
          prop.type,
          prop.isOptional,
        )
      }
      return nestedResult
    }),
    Match.tag("TupleType", () => []),
    Match.orElse(() => ""),
  )

  return match(ast)
}
