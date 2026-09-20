import { Data, Effect } from "effect"
import type { GraphQLOutputType, GraphQLSchema } from "graphql"
import {
  getNamedType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
} from "graphql"

export class SerializationError extends Data.TaggedError("SerializationError")<{
  readonly message: string
  readonly context?: Record<string, unknown>
}> {}

/**
 * Serializes a value according to its GraphQL output type definition.
 * This mimics GraphQL.js's internal `completeValue` function but works
 * outside of query execution.
 *
 * Recursively processes:
 * - NonNull types: unwraps and recurses
 * - List types: maps over array elements
 * - Scalar types: calls the scalar's serialize() method
 * - Object types: recursively serializes each field
 *
 * This ensures custom scalars (like DateTimeISO) are properly serialized
 * to their GraphQL output format, matching what Yoga's execution would produce.
 */
const serializeValue = (
  schema: GraphQLSchema,
  type: GraphQLOutputType,
  value: unknown,
): Effect.Effect<unknown, SerializationError> =>
  Effect.gen(function* () {
    // Handle null/undefined - return null
    if (value == null) {
      return null
    }

    // Unwrap NonNull wrapper and recurse
    if (isNonNullType(type)) {
      return yield* serializeValue(schema, type.ofType, value)
    }

    // Handle List types - map over array and recurse on each element
    if (isListType(type)) {
      if (!Array.isArray(value)) {
        return yield* new SerializationError({
          message: `Expected array for list type, got ${typeof value}`,
          context: { type: type.toString(), valueType: typeof value },
        })
      }
      return yield* Effect.all(
        value.map((item) => serializeValue(schema, type.ofType, item)),
      )
    }

    // Get the named type (unwrap any remaining wrappers)
    const namedType = getNamedType(type)

    // Handle Scalar types - call the scalar's serialize method
    if (isScalarType(namedType)) {
      return namedType.serialize(value)
    }

    // Handle Object types - recursively serialize each field
    if (isObjectType(namedType)) {
      const fields = namedType.getFields()
      const result: Record<string, unknown> = {}

      for (const [fieldName, fieldDef] of Object.entries(fields)) {
        const fieldValue = (value as Record<string, unknown>)[fieldName]
        if (fieldValue !== undefined) {
          result[fieldName] = yield* serializeValue(
            schema,
            fieldDef.type,
            fieldValue,
          )
        }
      }

      return result
    }

    // For other types (Interface, Union, Enum), return as-is
    // In practice, these should not appear in event data
    return value
  })

/**
 * Convenience function that serializes a value by type name instead of GraphQLOutputType.
 * Looks up the type in the schema and delegates to serializeValue().
 *
 * @param schema - The GraphQL schema containing type definitions
 * @param typeName - The name of the GraphQL type (e.g., "DraftProcessExecutionPullBulk")
 * @param value - The value to serialize
 * @returns Effect that resolves to the serialized value with all custom scalars properly formatted
 */
export const serializeValueByTypeName = <T>(
  schema: GraphQLSchema,
  typeName: string,
  value: T,
): Effect.Effect<T, SerializationError> =>
  Effect.gen(function* () {
    const type = schema.getType(typeName)

    if (!type) {
      return yield* new SerializationError({
        message: `Type "${typeName}" not found in schema`,
        context: {
          typeName,
          availableTypes: Object.keys(schema.getTypeMap()),
        },
      })
    }

    // Cast is safe: serialization preserves structure, only transforms scalar values
    return (yield* serializeValue(
      schema,
      type as GraphQLOutputType,
      value,
    )) as T
  })
