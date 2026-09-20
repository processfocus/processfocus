import { type Schema as ES, JSONSchema } from "effect"
import type { JsonSchema7, JsonSchema7Object } from "effect/JSONSchema"

/**
 * Converts Effect Schema JSON output to RxDB-compatible format.
 *
 * RxDB has strict schema requirements:
 * - No `$ref` references (must inline definitions)
 * - No `$id` properties
 * - No `title` or `description` on properties
 *
 * Effect Schema's JSONSchema.make() produces JSON Schema with these features,
 * so we need to transform the output for RxDB compatibility.
 */

type GeneratedJsonSchema = JsonSchema7Object & {
  $schema?: string
  $defs?: Record<string, JsonSchema7>
}

/**
 * Makes a property nullable by changing its type to allow null.
 * Converts `{ type: "number" }` to `{ type: ["number", "null"] }`.
 */
const makeNullable = (
  prop: Record<string, unknown>,
): Record<string, unknown> => {
  if ("type" in prop && typeof prop["type"] === "string") {
    return { ...prop, type: [prop["type"], "null"] }
  }
  return prop
}

/**
 * Converts Effect Schema JSON properties to RxDB-compatible format.
 * Inlines $ref references and removes unsupported metadata.
 */
export const toRxDbProperties = (
  properties: Record<string, unknown>,
  defs: Record<string, unknown> = {},
): Record<string, unknown> => {
  const resolved: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value !== "object" || value === null) {
      resolved[key] = value
      continue
    }

    const prop = value as Record<string, unknown>

    // Handle $ref by inlining the definition
    if ("$ref" in prop && typeof prop["$ref"] === "string") {
      const refPath = (prop["$ref"] as string).replace("#/$defs/", "")
      const inlined = defs[refPath]
      if (inlined && typeof inlined === "object") {
        resolved[key] = toRxDbProperty(inlined as Record<string, unknown>)
      } else {
        resolved[key] = toRxDbProperty(prop)
      }
    } else {
      resolved[key] = toRxDbProperty(prop)
    }
  }
  return resolved
}

/**
 * Cleans a single property definition for RxDB compatibility.
 * - Converts Effect's "unknown" type ($id: "/schemas/unknown") to object type
 * - Removes $id, $ref, title, description metadata
 * - Removes additionalProperties (RxDB doesn't support it)
 * - Recursively processes nested objects and arrays
 * - Makes optional nested fields nullable
 */
export const toRxDbProperty = (
  prop: Record<string, unknown>,
): Record<string, unknown> => {
  // Handle Effect Schema's "unknown" type - use object type for JSON values
  if (prop["$id"] === "/schemas/unknown") {
    return { type: "object" }
  }

  // Remove Effect Schema metadata that RxDB doesn't accept
  const { $id, $ref, title, description, additionalProperties, ...clean } = prop

  // Recursively process nested objects
  if (
    clean["type"] === "object" &&
    clean["properties"] &&
    typeof clean["properties"] === "object"
  ) {
    const nestedProps = clean["properties"] as Record<string, unknown>
    const requiredFields = new Set(
      Array.isArray(clean["required"]) ? clean["required"] : [],
    )

    const processedProps: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(nestedProps)) {
      if (typeof value === "object" && value !== null) {
        let processed = toRxDbProperty(value as Record<string, unknown>)
        // Make optional nested fields nullable
        if (!requiredFields.has(key)) {
          processed = makeNullable(processed)
        }
        processedProps[key] = processed
      } else {
        processedProps[key] = value
      }
    }
    return { ...clean, properties: processedProps }
  }

  // Recursively process array items
  if (clean["type"] === "array" && clean["items"]) {
    const items = clean["items"]
    if (typeof items === "object" && items !== null) {
      return {
        ...clean,
        items: toRxDbProperty(items as Record<string, unknown>),
      }
    }
  }

  return clean
}

/**
 * Converts an Effect Schema to RxDB-compatible JSON Schema.
 *
 * We need a conversion as Effect Schema returns references which RxDb
 * does not support.
 *
 * Optional fields are made nullable (type: ["x", "null"]) because GraphQL
 * returns null for missing optional values, and RxDB validates strictly.
 *
 * @param schema - Effect Struct Schema to convert
 * @returns Object with properties and required fields ready for RxDB
 */
export const toRxDbJsonSchema = <Fields extends ES.Struct.Fields>(
  schema: ES.Struct<Fields>,
): {
  properties: Record<string, unknown>
  required: readonly string[]
} => {
  // We have a struct, so we always have a JsonSchema7Object basically
  const generated = JSONSchema.make(schema) as GeneratedJsonSchema
  const allProperties = toRxDbProperties(generated.properties, generated.$defs)
  const requiredSet = new Set(generated.required)

  // Make optional fields nullable (they're not in required array)
  const propertiesWithNullable: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(allProperties)) {
    if (!requiredSet.has(key) && typeof value === "object" && value !== null) {
      propertiesWithNullable[key] = makeNullable(
        value as Record<string, unknown>,
      )
    } else {
      propertiesWithNullable[key] = value
    }
  }

  return {
    properties: propertiesWithNullable,
    required: generated.required,
  }
}
