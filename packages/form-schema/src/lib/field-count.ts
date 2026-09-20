import { Either, Schema } from "effect"
import { ArrayFormatter } from "effect/ParseResult"

const isKeyObject = (segment: unknown): segment is { key: PropertyKey } =>
  typeof segment === "object" &&
  segment !== null &&
  "key" in segment &&
  typeof segment.key !== "undefined"

const extractKey = (segment: unknown): PropertyKey | undefined => {
  if (segment === undefined) return undefined
  return isKeyObject(segment) ? segment.key : (segment as PropertyKey)
}

/**
 * Counts the number of top-level fields that have validation errors.
 * Assumes the schema has no Context requirements (all our form schemas are context-free).
 *
 * @param schema - Effect Schema to validate against
 * @param data - Data to validate
 * @returns Number of top-level fields with validation errors
 */
export const countInvalidFields = (
  schema: Schema.Schema.Any,
  data: unknown,
): number => {
  // Cast to context-free schema since our form schemas don't require context
  const contextFreeSchema = schema as Schema.Schema<unknown, unknown, never>

  // Try to decode - if it succeeds, no invalid fields
  const result = Schema.decodeUnknownEither(contextFreeSchema)(data, {
    errors: "all",
    onExcessProperty: "ignore",
  })

  // If validation succeeds, no invalid fields
  if (Either.isRight(result)) {
    return 0
  }

  // Format the error to get individual issues
  const issues = ArrayFormatter.formatErrorSync(result.left)

  // Count unique top-level field paths
  const fieldsWithErrors = new Set(
    issues
      .map((issue) => extractKey(issue.path[0]))
      .filter((key): key is PropertyKey => key !== undefined),
  )

  return fieldsWithErrors.size
}

/**
 * Counts the total number of fields in a schema.
 *
 * @param schema - Effect Schema struct to count fields in
 * @returns Total number of fields
 */
export const countTotalFields = (schema: {
  fields: Record<PropertyKey, unknown>
}): number => {
  return Object.keys(schema.fields).length
}

/**
 * Calculates how many fields are completed (valid) vs total fields.
 *
 * @param schema - Effect Schema to validate against
 * @param data - Data to validate
 * @returns Object with fieldsCompleted and totalFields
 */
export const calculateFieldCompletion = (
  schema: { fields: Record<PropertyKey, unknown> } & Schema.Schema.Any,
  data: unknown,
): { fieldsCompleted: number; totalFields: number } => {
  const totalFields = countTotalFields(schema)
  const invalidFields = countInvalidFields(schema, data)
  const fieldsCompleted = totalFields - invalidFields

  return { fieldsCompleted, totalFields }
}
