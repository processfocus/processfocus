import { Data, Effect, Match, Option } from "effect"
import * as AST from "effect/SchemaAST"
import {
  METRIC_BREAKDOWN_SYMBOL,
  STRUCTURAL_ONLY_SYMBOL,
  isMetricBreakdownOptions,
} from "@pf/form-schema"
import {
  isNotNullLiteral,
  literalUnionGraphQLType,
  mapLiteralToGraphQLType,
} from "./graphql-type-utils"

/**
 * Represents the result of walking a schema and generating GraphQL output types
 */
export interface GeneratedOutputTypes {
  /**
   * The main output type definition SDL
   */
  readonly main: string

  /**
   * Auxiliary (nested) output type definitions that the main type depends on
   */
  readonly auxiliary: readonly string[]
}

/**
 * Error types for output walker failures
 */
export class UnsupportedOutputSchemaTypeError extends Data.TaggedError(
  "UnsupportedOutputSchemaTypeError",
)<{
  readonly fieldName: string
  readonly schemaType: string
}> {
  override get message() {
    return `Cannot generate GraphQL output type for field "${this.fieldName}": schema type "${this.schemaType}" is not supported`
  }
}

export class OutputIndexSignaturesNotSupportedError extends Data.TaggedError(
  "OutputIndexSignaturesNotSupportedError",
  // biome-ignore lint/complexity/noBannedTypes: Effect TaggedError pattern
)<{}> {
  override get message() {
    return "Index signatures are not supported in GraphQL output types"
  }
}

export class UnrecognizedOutputASTNodeError extends Data.TaggedError(
  "UnrecognizedOutputASTNodeError",
)<{
  readonly nodeTag: string
}> {
  override get message() {
    return `AST node type "${this.nodeTag}" is not recognized`
  }
}

export class OutputInvalidPropertyKeyError extends Data.TaggedError(
  "OutputInvalidPropertyKeyError",
)<{
  readonly propertyKey: PropertyKey
}> {
  override get message() {
    return `Property keys must be strings, got: ${String(this.propertyKey)}`
  }
}

/**
 * Union of all output walker error types
 */
export type OutputWalkError =
  | UnsupportedOutputSchemaTypeError
  | OutputIndexSignaturesNotSupportedError
  | UnrecognizedOutputASTNodeError
  | OutputInvalidPropertyKeyError

/**
 * Validates that a property key is a string
 */
const validatePropertyKey = (
  propertyKey: PropertyKey,
): Effect.Effect<string, OutputInvalidPropertyKeyError> => {
  if (typeof propertyKey === "symbol" || typeof propertyKey === "number") {
    return Effect.fail(new OutputInvalidPropertyKeyError({ propertyKey }))
  }
  return Effect.succeed(propertyKey)
}

/**
 * Generates a GraphQL output type name for a nested field
 */
const generateNestedTypeName = (
  parentTypeName: string,
  fieldName: string,
): string => {
  // Capitalize first letter of field name
  const capitalizedFieldName =
    fieldName.charAt(0).toUpperCase() + fieldName.slice(1)
  return `${parentTypeName}${capitalizedFieldName}`
}

const getMetricBreakdownOptions = (type: AST.AST) => {
  const metricAnnotation = AST.getAnnotation(type, METRIC_BREAKDOWN_SYMBOL)
  const options = Option.getOrUndefined(metricAnnotation)

  return isMetricBreakdownOptions(options) ? options : undefined
}

const processMetricBreakdownOutputProperty = (
  fieldName: string,
  parentTypeName: string,
  isOptional: boolean,
): PropertyResult => {
  const metricTypeName = generateNestedTypeName(parentTypeName, fieldName)
  const fieldTypeName = `${metricTypeName}Field`
  const bucketTypeName = `${metricTypeName}Bucket`
  const nullability = isOptional ? "" : "!"

  return {
    fieldDefinition: `${fieldName}: ${metricTypeName}${nullability}`,
    auxiliary: [
      `type ${fieldTypeName} {
  label: String!
  value: String!
}`,
      `type ${bucketTypeName} {
  label: String!
  amount: Float!
  description: String
  color: String
}`,
      `type ${metricTypeName} {
  total: Float!
  currency: String!
  badge: String
  fields: [${fieldTypeName}!]!
  buckets: [${bucketTypeName}!]!
}`,
    ],
  }
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

/**
 * Main walker function that processes Effect Schema AST and generates GraphQL output type SDL
 *
 * @param ast - The Effect Schema AST to walk
 * @param typeName - The name for the GraphQL output type
 */
export const walkOutputAST = (
  ast: AST.AST,
  typeName: string,
): Effect.Effect<GeneratedOutputTypes, OutputWalkError> =>
  Match.type<AST.AST>().pipe(
    Match.tag("TypeLiteral", (typeLiteral) =>
      Effect.gen(function* () {
        const fields: string[] = []
        const allAuxiliary: string[] = []

        // Process each property signature
        for (const prop of typeLiteral.propertySignatures) {
          yield* validatePropertyKey(prop.name)
          const result = yield* processOutputProperty(prop, typeName)

          if (result) {
            fields.push(result.fieldDefinition)
            allAuxiliary.push(...result.auxiliary)
          }
        }

        // Index signatures are not supported
        if (typeLiteral.indexSignatures.length > 0) {
          return yield* new OutputIndexSignaturesNotSupportedError()
        }

        // Generate the main output type (using 'type' instead of 'input')
        const main = `type ${typeName} {
${fields.map((f) => `  ${f}`).join("\n")}
}`

        return {
          main,
          auxiliary: allAuxiliary,
        }
      }),
    ),
    Match.orElse((node) =>
      Effect.fail(new UnrecognizedOutputASTNodeError({ nodeTag: node._tag })),
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
const processOutputProperty = (
  prop: AST.PropertySignature,
  parentTypeName: string,
): Effect.Effect<PropertyResult | null, OutputWalkError> =>
  Effect.gen(function* () {
    const fieldName = yield* validatePropertyKey(prop.name)
    const isOptional = prop.isOptional
    const metricOptions = getMetricBreakdownOptions(prop.type)

    if (metricOptions?.dataSource === "item") {
      return processMetricBreakdownOutputProperty(
        fieldName,
        parentTypeName,
        isOptional,
      )
    }

    if (Option.isSome(AST.getAnnotation(prop.type, STRUCTURAL_ONLY_SYMBOL))) {
      // UI-only form elements are omitted from GraphQL output unless they opt
      // into item-backed data, as MetricBreakdown does with dataSource: "item".
      return null
    }

    return yield* processOutputType(
      prop.type,
      fieldName,
      parentTypeName,
      isOptional,
    )
  })

/**
 * Process an AST type node and return the field definition and auxiliary types
 */
const processOutputType = (
  type: AST.AST,
  fieldName: string,
  parentTypeName: string,
  isOptional: boolean,
): Effect.Effect<PropertyResult, OutputWalkError> => {
  return Match.type<AST.AST>().pipe(
    // Primitive types (String, Number, Boolean)
    Match.when(
      (ast) => mapToGraphQLType(ast._tag) !== undefined,
      (ast) => {
        const graphqlType = mapToGraphQLType(ast._tag)
        // This branch only executes when mapToGraphQLType returns a string
        if (!graphqlType) {
          return Effect.fail(
            new UnsupportedOutputSchemaTypeError({
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
          new UnsupportedOutputSchemaTypeError({
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

    // Nested struct - create a separate output type
    Match.tag("TypeLiteral", (typeLiteral) =>
      Effect.gen(function* () {
        const nestedTypeName = generateNestedTypeName(parentTypeName, fieldName)
        const result = yield* walkOutputAST(typeLiteral, nestedTypeName)
        const nullability = isOptional ? "" : "!"

        return {
          fieldDefinition: `${fieldName}: ${nestedTypeName}${nullability}`,
          auxiliary: [result.main, ...result.auxiliary],
        }
      }),
    ),

    // Refinement: unwrap to base type
    Match.tag("Refinement", (refinement) =>
      processOutputType(refinement.from, fieldName, parentTypeName, isOptional),
    ),

    // Transformation: use .to (output side) for output types
    Match.tag("Transformation", (transformation) =>
      processOutputType(
        transformation.to,
        fieldName,
        parentTypeName,
        isOptional,
      ),
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
          new UnsupportedOutputSchemaTypeError({
            fieldName,
            schemaType: type._tag,
          }),
        )
      }

      const nonUndefinedType = nonUndefinedTypes[0]

      if (!nonUndefinedType) {
        return Effect.fail(
          new UnsupportedOutputSchemaTypeError({
            fieldName,
            schemaType: "Union (all undefined)",
          }),
        )
      }

      return processOutputType(
        nonUndefinedType,
        fieldName,
        parentTypeName,
        isOptional || nonUndefinedTypes.length !== union.types.length,
      )
    }),

    // TupleType: Arrays with homogeneous element types
    Match.tag("TupleType", (tupleType) =>
      Effect.gen(function* () {
        // Get the element type from the tuple's rest type (for Array<T>)
        if (tupleType.rest.length === 0) {
          return yield* new UnsupportedOutputSchemaTypeError({
            fieldName,
            schemaType: "TupleType (no rest elements)",
          })
        }

        // Process the element type
        const elementType = tupleType.rest[0]
        if (!elementType) {
          return yield* new UnsupportedOutputSchemaTypeError({
            fieldName,
            schemaType: "TupleType (no element type)",
          })
        }

        // Process the element type to get its GraphQL representation
        const elementResult = yield* processOutputType(
          elementType.type,
          `${fieldName}Item`,
          parentTypeName,
          false, // Array elements are always non-null in the type
        )

        // Extract the type name from the field definition
        const typeMatch = elementResult.fieldDefinition.match(/:\s*(.+?)!?\s*$/)
        if (!typeMatch) {
          return yield* new UnsupportedOutputSchemaTypeError({
            fieldName,
            schemaType: "TupleType (could not extract element type)",
          })
        }

        const elementTypeName = typeMatch[1]?.replace("!", "") ?? "Unknown"
        const nullability = isOptional ? "" : "!"

        return {
          fieldDefinition: `${fieldName}: [${elementTypeName}!]${nullability}`,
          auxiliary: elementResult.auxiliary,
        }
      }),
    ),

    // Unsupported type
    Match.orElse(() =>
      Effect.fail(
        new UnsupportedOutputSchemaTypeError({
          fieldName,
          schemaType: type._tag,
        }),
      ),
    ),
  )(type)
}
