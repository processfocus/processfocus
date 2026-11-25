import { Result, Schema, SchemaIssue } from "effect"

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
  schema: Schema.Top,
  data: unknown,
): number => {
  // Cast to context-free schema since our form schemas don't require context
  const contextFreeSchema = schema as Schema.Codec<
    unknown,
    unknown,
    never,
    never
  >

  const result = Schema.decodeUnknownResult(contextFreeSchema)(data, {
    errors: "all",
    onExcessProperty: "ignore",
  })

  if (Result.isSuccess(result)) {
    return 0
  }

  const issues = SchemaIssue.makeFormatterStandardSchemaV1()(
    result.failure.issue,
  ).issues

  const fieldsWithErrors = new Set(
    issues
      .map((issue) => extractKey(issue.path?.[0]))
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
  schema: { fields: Record<PropertyKey, unknown> } & Schema.Top,
  data: unknown,
): { fieldsCompleted: number; totalFields: number } => {
  const totalFields = countTotalFields(schema)
  const invalidFields = countInvalidFields(schema, data)
  const fieldsCompleted = totalFields - invalidFields

  return { fieldsCompleted, totalFields }
}
