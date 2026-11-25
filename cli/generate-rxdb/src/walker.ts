import { Data, Effect, Match } from "effect"
import * as AST from "effect/SchemaAST"

/**
 * Represents a field in a GraphQL type
 */
export interface GraphQLField {
  readonly name: string
  readonly type: string
  readonly nullable: boolean
}

/**
 * Represents a nested GraphQL type that needs to be generated
 */
export interface NestedType {
  readonly name: string
  readonly fields: readonly GraphQLField[]
}

/**
 * Result of walking a collection schema
 */
interface CollectionTypes {
  readonly fields: readonly GraphQLField[]
  readonly nestedTypes: readonly NestedType[]
}

/**
 * Error types for walker failures
 */
class UnsupportedSchemaTypeError extends Data.TaggedError(
  "UnsupportedSchemaTypeError",
)<{
  readonly fieldName: string
  readonly schemaType: string
}> {
  override get message() {
    return `Cannot generate GraphQL type for field "${this.fieldName}": schema type "${this.schemaType}" is not supported`
  }
}

class InvalidPropertyKeyError extends Data.TaggedError(
  "InvalidPropertyKeyError",
)<{
  readonly propertyKey: PropertyKey
}> {
  override get message() {
    return `Property keys must be strings, got: ${String(this.propertyKey)}`
  }
}

class UnrecognizedASTNodeError extends Data.TaggedError(
  "UnrecognizedASTNodeError",
)<{
  readonly nodeTag: string
}> {
  override get message() {
    return `AST node type "${this.nodeTag}" is not recognized`
  }
}

/**
 * Union of all walker error types
 */
export type WalkError =
  | UnsupportedSchemaTypeError
  | InvalidPropertyKeyError
  | UnrecognizedASTNodeError

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
 * Maps Effect Schema AST tag to GraphQL type
 */
const mapToGraphQLType = (
  astTag: string,
  fieldName: string,
): string | undefined => {
  switch (astTag) {
    case "String":
      return fieldName === "id" ? "ID" : "String"
    case "Number":
      // Number is always Float - Int types have identifier annotations
      return "Float"
    case "Boolean":
      return "Boolean"
    case "Unknown":
      return "JSON"
    default:
      return undefined
  }
}

const hasCheck = (
  checks: ReadonlyArray<AST.Check<unknown>>,
  id: string,
): boolean =>
  checks.some(
    (check) =>
      check.annotations?.representation?.id === id ||
      (check._tag === "FilterGroup" && hasCheck(check.checks, id)),
  )

const isDateTimeUtc = (ast: AST.AST): boolean =>
  AST.resolveAt<{ readonly id: string }>("representation")(ast)?.id ===
  "effect/schema/DateTimeUtc"

const isInt = (ast: AST.AST): boolean =>
  ast._tag === "Number" && hasCheck(ast.checks ?? [], "effect/schema/isInt")

const isBigInt = (ast: AST.AST): boolean => ast._tag === "BigInt"

/**
 * Context passed during walking to collect nested types
 */
interface WalkContext {
  readonly nestedTypes: NestedType[]
  readonly collectionName: string
}

/**
 * Main walker function that processes Effect Schema AST and extracts field information
 */
export const walkCollectionSchema = (
  ast: AST.AST,
  collectionName = "Root",
): Effect.Effect<CollectionTypes, WalkError> =>
  Match.type<AST.AST>().pipe(
    Match.tag("Objects", (typeLiteral) =>
      Effect.gen(function* () {
        const fields: GraphQLField[] = []
        const context: WalkContext = { nestedTypes: [], collectionName }

        for (const prop of typeLiteral.propertySignatures) {
          const fieldName = yield* validatePropertyKey(prop.name)
          const field = yield* processProperty(prop, fieldName, context)
          fields.push(field)
        }

        return { fields, nestedTypes: context.nestedTypes }
      }),
    ),
    Match.orElse((node) =>
      Effect.fail(new UnrecognizedASTNodeError({ nodeTag: node._tag })),
    ),
  )(ast)

/**
 * Process a single property signature
 */
const processProperty = (
  prop: AST.PropertySignature,
  fieldName: string,
  context: WalkContext,
): Effect.Effect<GraphQLField, WalkError> =>
  Effect.gen(function* () {
    const isOptional = AST.isOptional(prop.type)
    const graphQLType = yield* determineGraphQLType(
      prop.type,
      fieldName,
      context,
    )

    return {
      name: fieldName,
      type: graphQLType,
      nullable: isOptional,
    }
  })

/**
 * Check if a Objects is a Record type (has indexSignatures, no propertySignatures)
 */
const isRecordType = (typeLiteral: AST.Objects): boolean =>
  typeLiteral.propertySignatures.length === 0 &&
  typeLiteral.indexSignatures.length > 0

/**
 * Check if a Objects is a nested Struct type (has propertySignatures)
 */
const isNestedStructType = (typeLiteral: AST.Objects): boolean =>
  typeLiteral.propertySignatures.length > 0

/**
 * Convert a field name to a nested type name (PascalCase)
 */
const toNestedTypeName = (
  collectionName: string,
  fieldName: string,
): string => {
  const pascalFieldName = fieldName.charAt(0).toUpperCase() + fieldName.slice(1)
  return `${collectionName}${pascalFieldName}`
}

/**
 * Determine the GraphQL type for an AST node
 */
const determineGraphQLType = (
  type: AST.AST,
  fieldName: string,
  context: WalkContext,
): Effect.Effect<string, WalkError> => {
  return Match.type<AST.AST>().pipe(
    // Check for branded/refined types with identifier annotations
    Match.when(isDateTimeUtc, () => Effect.succeed("DateTimeISO")),
    Match.when(isInt, () => Effect.succeed("Int")),
    Match.when(
      isBigInt,
      () => Effect.succeed("String"), // GraphQL doesn't have native BigInt, use String
    ),

    Match.when(
      (ast) => ast.encoding !== undefined,
      (ast) => determineGraphQLType(AST.toEncoded(ast), fieldName, context),
    ),

    // Primitive types
    Match.when(
      (ast) => mapToGraphQLType(ast._tag, fieldName) !== undefined,
      (ast) => {
        const graphqlType = mapToGraphQLType(ast._tag, fieldName)
        if (!graphqlType) {
          return Effect.fail(
            new UnsupportedSchemaTypeError({
              fieldName,
              schemaType: ast._tag,
            }),
          )
        }
        return Effect.succeed(graphqlType)
      },
    ),

    // Objects: either Record (-> JSON) or nested Struct (-> new type)
    Match.tag("Objects", (typeLiteral) => {
      // Record type: has indexSignatures, no propertySignatures -> JSON
      if (isRecordType(typeLiteral)) {
        return Effect.succeed("JSON")
      }

      // Nested Struct type: has propertySignatures -> generate nested type
      if (isNestedStructType(typeLiteral)) {
        return Effect.gen(function* () {
          const nestedTypeName = toNestedTypeName(
            context.collectionName,
            fieldName,
          )
          const nestedFields: GraphQLField[] = []

          for (const prop of typeLiteral.propertySignatures) {
            const propName = yield* validatePropertyKey(prop.name)
            const nestedContext: WalkContext = {
              ...context,
              collectionName: nestedTypeName,
            }
            const field = yield* processProperty(prop, propName, nestedContext)
            nestedFields.push(field)
          }

          context.nestedTypes.push({
            name: nestedTypeName,
            fields: nestedFields,
          })

          return nestedTypeName
        })
      }

      // Empty Objects - unlikely but handle gracefully
      return Effect.succeed("JSON")
    }),

    // Union: extract first non-undefined type
    Match.tag("Union", (union) => {
      const nonUndefinedType = union.types.find(
        (t) => t._tag !== "Undefined" && t._tag !== "Void",
      )

      if (!nonUndefinedType) {
        return Effect.fail(
          new UnsupportedSchemaTypeError({
            fieldName,
            schemaType: "Union (all undefined)",
          }),
        )
      }

      return determineGraphQLType(nonUndefinedType, fieldName, context)
    }),

    // Literal: map to String in GraphQL (for string literals)
    Match.tag("Literal", () => Effect.succeed("String")),

    // Arrays: arrays, extract element type
    Match.tag("Arrays", (tuple) => {
      // For Schema.Array, the AST is Arrays with empty elements and rest
      // The element type is in the rest property
      const restElement = tuple.rest[0]
      if (restElement !== undefined) {
        const elementType = restElement
        return Effect.gen(function* () {
          const itemType = yield* determineGraphQLType(
            elementType,
            fieldName,
            context,
          )
          return `[${itemType}!]`
        })
      }
      // Fixed-size tuple - use JSON as fallback
      return Effect.succeed("JSON")
    }),

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
