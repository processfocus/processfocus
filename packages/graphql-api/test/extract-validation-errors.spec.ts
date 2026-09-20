// biome-ignore-all lint/style/noNonNullAssertion: test assertions
import { Either, Schema } from "effect"
import { InputValidationError } from "@pf/graphql-schema"
import { extractValidationErrors } from "../src/lib/resolver-utils"
import { describe, expect, it } from "bun:test"

/**
 * Helper to validate input and extract errors.
 * Tests the validation logic directly without going through authorization.
 */
const validateAndExtractErrors = <A, I>(
  schema: Schema.Schema<A, I, never>,
  input: unknown,
): InputValidationError => {
  const result = Schema.decodeUnknownEither(schema, { errors: "all" })(input)

  if (Either.isLeft(result)) {
    const errors = extractValidationErrors(result.left)
    return new InputValidationError({ errors })
  }
  throw new Error("Expected validation to fail but it succeeded")
}

describe("extractValidationErrors", () => {
  describe("validation errors", () => {
    it("returns error with path for missing required field", () => {
      const schema = Schema.Struct({
        name: Schema.NonEmptyString,
      })

      const validationError = validateAndExtractErrors(schema, { name: "" })

      expect(validationError.errors).toHaveLength(1)
      expect(validationError.errors[0]?.field).toBe("name")
    })

    it("returns error with dot notation path for nested field", () => {
      const schema = Schema.Struct({
        address: Schema.Struct({
          city: Schema.NonEmptyString,
        }),
      })

      const validationError = validateAndExtractErrors(schema, {
        address: { city: "" },
      })

      expect(validationError.errors).toHaveLength(1)
      expect(validationError.errors[0]?.field).toBe("address.city")
    })

    it("returns all validation errors with errors: all", () => {
      const schema = Schema.Struct({
        name: Schema.NonEmptyString,
        email: Schema.NonEmptyString,
      })

      const validationError = validateAndExtractErrors(schema, {
        name: "",
        email: "",
      })

      expect(validationError.errors).toHaveLength(2)
      const fields = validationError.errors.map((e) => e.field).sort()
      expect(fields).toEqual(["email", "name"])
    })

    it("returns error with array index in path", () => {
      const schema = Schema.Struct({
        items: Schema.Array(
          Schema.Struct({
            name: Schema.NonEmptyString,
          }),
        ),
      })

      const validationError = validateAndExtractErrors(schema, {
        items: [{ name: "" }],
      })

      expect(validationError.errors).toHaveLength(1)
      expect(validationError.errors[0]?.field).toBe("items.0.name")
    })

    it("includes meaningful error messages", () => {
      const schema = Schema.Struct({
        age: Schema.Number.pipe(Schema.positive()),
      })

      const validationError = validateAndExtractErrors(schema, { age: -5 })

      expect(validationError.errors[0]?.field).toBe("age")
      expect(validationError.errors[0]?.message).toBeTruthy()
    })

    it("generates correct error message for single field", () => {
      const schema = Schema.Struct({
        name: Schema.NonEmptyString,
      })

      const validationError = validateAndExtractErrors(schema, { name: "" })

      expect(validationError.message).toMatch(
        /Validation failed for field 'name':/,
      )
    })

    it("generates a form-level message for root validation errors", () => {
      const schema = Schema.Struct({
        min: Schema.Number,
        max: Schema.Number,
      }).pipe(
        Schema.filter((input) => input.min <= input.max, {
          message: () => "min must not exceed max",
        }),
      )

      const validationError = validateAndExtractErrors(schema, {
        min: 10,
        max: 1,
      })

      expect(validationError.errors[0]?.field).toBe("")
      expect(validationError.message).toBe(
        "Validation failed: min must not exceed max",
      )
    })

    it("generates correct error message for multiple fields", () => {
      const schema = Schema.Struct({
        name: Schema.NonEmptyString,
        email: Schema.NonEmptyString,
      })

      const validationError = validateAndExtractErrors(schema, {
        name: "",
        email: "",
      })

      expect(validationError.message).toMatch(/Validation failed for fields:/)
      expect(validationError.message).toContain("'name':")
      expect(validationError.message).toContain("'email':")
    })
  })
})
