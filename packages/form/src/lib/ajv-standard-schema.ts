import type { StandardSchemaV1 } from "@standard-schema/spec"
import Ajv, { type ErrorObject } from "ajv"
import isEmail from "validator/lib/isEmail"
import { friendlyJsonSchemaValidationMessage } from "./friendly-validation-message"

// Effect may emit stable $id values for generated schemas. React dev remounts can
// compile the same schema repeatedly, so don't register compiled schemas globally.
const ajv = new Ajv({ allErrors: true, addUsedSchema: false })

// Do not import JSONSchema types from Effect here. This package renders client
// forms in the browser, and Effect is large enough that accidental client
// bundling would noticeably hurt form load performance.
export type JsonSchemaRoot = Record<string, unknown>

// Register x-message as a known keyword so AJV strict mode doesn't reject it.
// It's only used for custom error messages, not for validation logic.
ajv.addKeyword("x-message")

ajv.addFormat("email", {
  type: "string",
  validate: (s: string) =>
    isEmail(s, {
      require_tld: false,
      allow_utf8_local_part: true,
      allow_ip_domain: true,
    }),
})

const validPhoneCharacters = /^\+?[\d\s()-]+$/
const countDigits = (s: string) => s.match(/\d/g)?.length ?? 0

// Keep this small validator local instead of importing @pf/form-schema, which
// would pull Effect Schema field constructors into the client form renderer.
// Keep it in sync with packages/form-schema/src/lib/phone.ts.
ajv.addFormat("phone", {
  type: "string",
  validate: (s: string) => {
    if (!validPhoneCharacters.test(s)) {
      return false
    }

    const digitCount = countDigits(s)
    return digitCount >= 7 && digitCount <= 15
  },
})

/**
 * Creates a Standard Schema compatible validator from a JSON Schema.
 * This allows JSON Schema validation via Ajv to work with libraries
 * that expect Standard Schema validators (like TanStack Form).
 *
 * @param jsonSchema - The JSON Schema to validate against
 * @returns A Standard Schema compatible validator object
 *
 * @example
 * ```typescript
 * const validator = createStandardSchemaFromJsonSchema({
 *   type: "object",
 *   properties: { name: { type: "string" }, age: { type: "number" } },
 *   required: ["name", "age"],
 * })
 *
 * // Use with TanStack Form
 * const form = useForm({
 *   validators: {
 *     onDynamic: validator
 *   }
 * })
 * ```
 */
/**
 * Extract x-message annotations from JSON Schema properties.
 * These are custom validation messages set via Effect Schema's jsonSchema annotation.
 */
const extractMessages = (jsonSchema: JsonSchemaRoot): Map<string, string> => {
  const messages = new Map<string, string>()
  const properties = jsonSchema["properties"] as
    | Record<string, Record<string, unknown>>
    | undefined
  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      if (typeof value["x-message"] === "string") {
        messages.set(key, value["x-message"])
      }
    }
  }
  return messages
}

const getPathParts = (error: ErrorObject): string[] => {
  const pathParts = error.instancePath
    ? error.instancePath.split("/").filter(Boolean)
    : []

  if (error.keyword !== "required") {
    return pathParts
  }

  const missingProperty = (error.params as { missingProperty?: unknown })[
    "missingProperty"
  ]

  return typeof missingProperty === "string"
    ? [...pathParts, missingProperty]
    : pathParts
}

export const createStandardSchemaFromJsonSchema = <T = object>(
  jsonSchema: JsonSchemaRoot,
): StandardSchemaV1<Record<string, unknown>, T> => {
  const validate = ajv.compile(jsonSchema)
  const messages = extractMessages(jsonSchema)
  return {
    "~standard": {
      version: 1,
      vendor: "ajv",
      validate: (value: unknown): StandardSchemaV1.Result<T> => {
        const valid = validate(value)

        if (valid) {
          return {
            value: value as T,
            issues: undefined,
          }
        }

        // Convert Ajv errors to a standard issues format.
        // LIMITATION: Only top-level fields get custom messages. Nested paths
        // would need hierarchical message lookup (e.g., "parent.child").
        // Use x-message from JSON Schema properties when available,
        // falling back to friendly UI copy for common validator messages.
        const issues: ReadonlyArray<StandardSchemaV1.Issue> = (
          validate.errors || []
        ).map((error: ErrorObject) => {
          const pathParts = getPathParts(error)
          const fieldName = pathParts[0]
          const customMessage =
            fieldName !== undefined ? messages.get(fieldName) : undefined
          return {
            path: pathParts,
            message:
              customMessage ?? friendlyJsonSchemaValidationMessage(error),
            keyword: error.keyword,
            params: error.params,
          }
        })

        return { issues }
      },
    },
  }
}
