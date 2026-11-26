import { JsonSchema, Schema, SchemaRepresentation } from "effect"

/** Keep the v3 JSON-number contract instead of v4's non-finite string codec. */
const preserveJsonNumbers = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(preserveJsonNumbers)
  if (value === null || typeof value !== "object") return value
  const object = value as Record<string, unknown>
  const assertions = object["allOf"]
  if (
    Array.isArray(assertions) &&
    assertions.length === 1 &&
    assertions[0]?.enum
  ) {
    const { allOf: _, ...rest } = object
    return preserveJsonNumbers({ ...rest, ...assertions[0] })
  }
  const alternatives = object["anyOf"]
  if (
    Array.isArray(alternatives) &&
    alternatives.length === 2 &&
    alternatives[0]?.type === "number" &&
    alternatives[1]?.type === "string" &&
    Array.isArray(alternatives[1].enum) &&
    alternatives[1].enum.length === 3 &&
    ["Infinity", "-Infinity", "NaN"].every((value) =>
      alternatives[1].enum.includes(value),
    )
  ) {
    const { anyOf: _, ...rest } = object
    return { ...rest, ...alternatives[0] }
  }
  return Object.fromEntries(
    Object.entries(object).map(([key, item]) => [
      key,
      preserveJsonNumbers(item),
    ]),
  )
}

/** Render the existing draft-07 form contract, including referenced definitions. */
export const toFormJsonSchema = (
  schema: Schema.Constraint,
): JsonSchema.JsonSchema => {
  const document = JsonSchema.toDocumentDraft07(
    // Compile the authored encoded shape directly. Canonical JSON codecs add
    // a Number transformation that drops its checks and annotations.
    SchemaRepresentation.toJsonSchemaDocument(Schema.toRepresentation(schema), {
      onExcessProperty: "error",
    }),
  )
  return preserveJsonNumbers({
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07,
    ...document.schema,
    ...(Object.keys(document.definitions).length
      ? { definitions: document.definitions }
      : {}),
  }) as JsonSchema.JsonSchema
}
