import { Data, Effect, Match } from "effect"
import type * as AST from "effect/SchemaAST"
import {
  isNotNullLiteral,
  literalUnionGraphQLType,
  mapLiteralToGraphQLType,
} from "./graphql-type-utils"

/**
 * Represents the result of walking a schema and generating GraphQL types
 */
export interface GeneratedTypes {
  /**
   * The main input type definition SDL
   */
  readonly main: string

  /**
   * Auxiliary (nested) input type definitions that the main type depends on
   */
  readonly auxiliary: readonly string[]
}

/**
 * Error types for walker failures
 */
export class UnsupportedSchemaTypeError extends Data.TaggedError(
  "UnsupportedSchemaTypeError",
)<{
  readonly fieldName: string
  readonly schemaType: string
}> {
  override get message() {
    return `Cannot generate GraphQL input type for field "${this.fieldName}": schema type "${this.schemaType}" is not supported`
  }
}

export class IndexSignaturesNotSupportedError extends Data.TaggedError(
  "IndexSignaturesNotSupportedError",
  // biome-ignore lint/complexity/noBannedTypes: Effect TaggedError pattern
)<{}> {
  override get message() {
    return "Index signatures are not supported in GraphQL input types"
  }
}

export class UnrecognizedASTNodeError extends Data.TaggedError(
  "UnrecognizedASTNodeError",
)<{
  readonly nodeTag: string
}> {
  override get message() {
    return `AST node type "${this.nodeTag}" is not recognized`
  }
}

export class InvalidPropertyKeyError extends Data.TaggedError(
  "InvalidPropertyKeyError",
)<{
  readonly propertyKey: PropertyKey
}> {
  override get message() {
    return `Property keys must be strings, got: ${String(this.propertyKey)}`
  }
}

/**
 * Union of all walker error types
 */
export type WalkError =
  | UnsupportedSchemaTypeError
  | IndexSignaturesNotSupportedError
  | UnrecognizedASTNodeError
  | InvalidPropertyKeyError

/**
 * Validates that a property key is a string
 */
const validatePropertyKey = (
  propertyKey: PropertyKey,
): Effect.Effect<string, InvalidPropertyKeyError> => {
  if (typeof propertyKey === "symbol" || typeof propertyKey === "number") {
    return Effect.fail(new InvalidPropertyKeyError({ propertyKey }))
  }
  return Effect.succeed(propertyKey)
}

/**
 * Generates a GraphQL input type name for a nested field
 */
const generateNestedTypeName = (
  parentTypeName: string,
  fieldName: string,
): string => {
  // Capitalize first letter of field name
  const capitalizedFieldName =
    fieldName.charAt(0).toUpperCase() + fieldName.slice(1)
  return `${parentTypeName}${capitalizedFieldName}Input`
}

/**
 * Maps GraphQL type name to GraphQL scalar type
 */
const mapToGraphQLType = (astTag: string): string | undefined => {
  switch (astTag) {
    case "StringKeyword":
      return "String"
    case "NumberKeyword":
      return "Float"
    case "BooleanKeyword":
      return "Boolean"
    default:
      return undefined
  }
}

const mapASTToGraphQLScalar = (ast: AST.AST): string | undefined => {
  if (ast._tag === "Literal") {
    return mapLiteralToGraphQLType(ast.literal)
  }

  if (ast._tag === "Union") {
    return literalUnionGraphQLType(
      ast.types.filter(
        (member) =>
          member._tag !== "UndefinedKeyword" &&
          member._tag !== "VoidKeyword" &&
          isNotNullLiteral(member),
      ),
    )
  }

  return mapToGraphQLType(ast._tag)
}

/**
 * Main walker function that processes Effect Schema AST and generates GraphQL input type SDL
 *
 * @param ast - The Effect Schema AST to walk
 * @param typeName - The name for the GraphQL input type
 */
export const walkAST = (
  ast: AST.AST,
  typeName: string,
): Effect.Effect<GeneratedTypes, WalkError> =>
  Match.type<AST.AST>().pipe(
    Match.tag("TypeLiteral", (typeLiteral) =>
      Effect.gen(function* () {
        const fields: string[] = []
        const allAuxiliary: string[] = []

        // Process each property signature
        for (const prop of typeLiteral.propertySignatures) {
          // Structural form elements encode display-only fields as Undefined.
          // They can cross a bundled organisation boundary without their
          // library-local annotation map, but they are still never GraphQL
          // inputs and must not become invalid `UndefinedKeyword` fields.
          if (
            prop.type._tag === "UndefinedKeyword" ||
            prop.type._tag === "VoidKeyword"
          ) {
            continue
          }
          yield* validatePropertyKey(prop.name)
          const result = yield* processProperty(prop, typeName)

          fields.push(result.fieldDefinition)
          allAuxiliary.push(...result.auxiliary)
        }

        // Index signatures are not supported
        if (typeLiteral.indexSignatures.length > 0) {
          return yield* new IndexSignaturesNotSupportedError()
        }

        // Generate the main input type
        const main = `input ${typeName} {
${fields.map((f) => `  ${f}`).join("\n")}
}`

        return {
          main,
          auxiliary: allAuxiliary,
        }
      }),
    ),
    Match.orElse((node) =>
      Effect.fail(new UnrecognizedASTNodeError({ nodeTag: node._tag })),
    ),
  )(ast)

/**
 * Result of processing a single property
 */
interface PropertyResult {
  /**
   * The GraphQL field definition (e.g., "username: String!")
   */
  readonly fieldDefinition: string

  /**
   * Any auxiliary types this property depends on
   */
  readonly auxiliary: readonly string[]
}

/**
 * Process a single property signature from the schema
 */
const processProperty = (
  prop: AST.PropertySignature,
  parentTypeName: string,
): Effect.Effect<PropertyResult, WalkError> =>
  Effect.gen(function* () {
    const fieldName = yield* validatePropertyKey(prop.name)
    const isOptional = prop.isOptional

    return yield* processType(prop.type, fieldName, parentTypeName, isOptional)
  })

/**
 * Process an AST type node and return the field definition and auxiliary types
 */
const processType = (
  type: AST.AST,
  fieldName: string,
  parentTypeName: string,
  isOptional: boolean,
): Effect.Effect<PropertyResult, WalkError> => {
  return Match.type<AST.AST>().pipe(
    // Primitive types (String, Number, Boolean)
    Match.when(
      (ast) => mapToGraphQLType(ast._tag) !== undefined,
      (ast) => {
        const graphqlType = mapToGraphQLType(ast._tag)
        // This branch only executes when mapToGraphQLType returns a string
        if (!graphqlType) {
          return Effect.fail(
            new UnsupportedSchemaTypeError({
              fieldName,
              schemaType: ast._tag,
            }),
          )
        }
        const nullability = isOptional ? "" : "!"
        return Effect.succeed({
          fieldDefinition: `${fieldName}: ${graphqlType}${nullability}`,
          auxiliary: [],
        })
      },
    ),

    Match.tag("Literal", (literal) => {
      const graphqlType = mapLiteralToGraphQLType(literal.literal)
      if (!graphqlType) {
        return Effect.fail(
          new UnsupportedSchemaTypeError({
            fieldName,
            schemaType: type._tag,
          }),
        )
      }
      const nullability = isOptional ? "" : "!"
      return Effect.succeed({
        fieldDefinition: `${fieldName}: ${graphqlType}${nullability}`,
        auxiliary: [],
      })
    }),

    // Nested struct - create a separate input type
    Match.tag("TypeLiteral", (typeLiteral) =>
      Effect.gen(function* () {
        const nestedTypeName = generateNestedTypeName(parentTypeName, fieldName)
        const result = yield* walkAST(typeLiteral, nestedTypeName)
        const nullability = isOptional ? "" : "!"

        return {
          fieldDefinition: `${fieldName}: ${nestedTypeName}${nullability}`,
          auxiliary: [result.main, ...result.auxiliary],
        }
      }),
    ),

    // Array/list field: Schema.Array produces TupleType with rest: [Type(itemAST)]
    Match.tag("TupleType", (tuple) => {
      const restType = tuple.rest[0]
      if (!restType) {
        return Effect.fail(
          new UnsupportedSchemaTypeError({
            fieldName,
            schemaType: "TupleType (empty)",
          }),
        )
      }
      const itemAST = restType.type
      const nullability = isOptional ? "" : "!"

      // Check if item is a struct (TypeLiteral) — create nested input type
      if (itemAST._tag === "TypeLiteral") {
        const nestedTypeName = generateNestedTypeName(
          parentTypeName,
          `${fieldName}Item`,
        )
        return walkAST(itemAST, nestedTypeName).pipe(
          Effect.map((result) => ({
            fieldDefinition: `${fieldName}: [${nestedTypeName}!]${nullability}`,
            auxiliary: [result.main, ...result.auxiliary],
          })),
        )
      }

      // Primitive item — use scalar list
      const graphqlType = mapASTToGraphQLScalar(itemAST)
      if (graphqlType) {
        return Effect.succeed({
          fieldDefinition: `${fieldName}: [${graphqlType}!]${nullability}`,
          auxiliary: [],
        })
      }

      return Effect.fail(
        new UnsupportedSchemaTypeError({
          fieldName,
          schemaType: `TupleType (item: ${itemAST._tag})`,
        }),
      )
    }),

    // Refinement: unwrap to base type
    Match.tag("Refinement", (refinement) =>
      processType(refinement.from, fieldName, parentTypeName, isOptional),
    ),

    // Transformation: use .from (input side)
    Match.tag("Transformation", (transformation) =>
      processType(transformation.from, fieldName, parentTypeName, isOptional),
    ),

    // Union: for optional fields (String | Undefined)
    // Extract the first non-undefined type from the union
    Match.tag("Union", (union) => {
      // Find the first non-undefined/non-void type
      const nonUndefinedTypes = union.types.filter(
        (t) =>
          t._tag !== "UndefinedKeyword" &&
          t._tag !== "VoidKeyword" &&
          isNotNullLiteral(t),
      )
      const literalGraphQLType = literalUnionGraphQLType(nonUndefinedTypes)
      if (literalGraphQLType) {
        const optional =
          isOptional || nonUndefinedTypes.length !== union.types.length
        return Effect.succeed({
          fieldDefinition: `${fieldName}: ${literalGraphQLType}${optional ? "" : "!"}`,
          auxiliary: [],
        })
      }

      if (nonUndefinedTypes.length > 1) {
        return Effect.fail(
          new UnsupportedSchemaTypeError({
            fieldName,
            schemaType: type._tag,
          }),
        )
      }

      const nonUndefinedType = nonUndefinedTypes[0]

      if (!nonUndefinedType) {
        return Effect.fail(
          new UnsupportedSchemaTypeError({
            fieldName,
            schemaType: "Union (all undefined)",
          }),
        )
      }

      return processType(
        nonUndefinedType,
        fieldName,
        parentTypeName,
        isOptional || nonUndefinedTypes.length !== union.types.length,
      )
    }),

    // Unsupported type
    Match.orElse(() =>
      Effect.fail(
        new UnsupportedSchemaTypeError({
          fieldName,
          schemaType: type._tag,
        }),
      ),
    ),
  )(type)
}
