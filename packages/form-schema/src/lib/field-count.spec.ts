import { Schema as ES } from "effect"
import {
  calculateFieldCompletion,
  countInvalidFields,
  countTotalFields,
} from "./field-count"
import {
  BooleanField,
  Divider,
  NumberField,
  TextBlock,
  TextField,
  Wrapper,
} from "./form-schema"
import { describe, expect, it } from "bun:test"

describe("countTotalFields", () => {
  it("should count fields in a simple schema", () => {
    const schema = ES.Struct({
      username: ES.String,
      age: ES.Number,
      email: ES.String,
    })

    expect(countTotalFields(schema)).toBe(3)
  })

  it("should count zero fields in an empty schema", () => {
    const schema = ES.Struct({})

    expect(countTotalFields(schema)).toBe(0)
  })

  it("should count fields with optional properties", () => {
    const schema = ES.Struct({
      username: ES.String,
      email: ES.optional(ES.String),
      age: ES.optional(ES.Number),
    })

    expect(countTotalFields(schema)).toBe(3)
  })

  it("should count fields including nested structs", () => {
    const schema = ES.Struct({
      username: ES.String,
      address: ES.Struct({
        street: ES.String,
        city: ES.String,
      }),
    })

    expect(countTotalFields(schema)).toBe(2) // Only top-level fields
  })

  it("should count fields with form helpers", () => {
    const schema = ES.Struct({
      username: TextField({ label: "Username" }),
      age: NumberField({ label: "Age" }),
      acceptTerms: BooleanField({ label: "Accept terms" }),
    })

    expect(countTotalFields(schema)).toBe(3)
  })

  it("should count fields including structural elements", () => {
    const schema = ES.Struct({
      title: TextBlock("Welcome"),
      username: ES.String,
      divider: Divider,
      email: ES.String,
    })

    // Structural elements like TextBlock and Divider are counted as fields
    // (they're part of the schema structure even if not submitted)
    expect(countTotalFields(schema)).toBe(4)
  })

  it("should count fields including wrappers", () => {
    const schema = ES.Struct({
      username: ES.String,
      address: Wrapper({
        street: ES.String,
        city: ES.String,
      }),
    })

    expect(countTotalFields(schema)).toBe(2) // Only top-level: username and address wrapper
  })
})

describe("countInvalidFields", () => {
  it("should return 0 for valid data against simple schema", () => {
    const schema = ES.Struct({
      username: ES.String,
      age: ES.Number,
    })

    const data = {
      username: "john",
      age: 25,
    }

    expect(countInvalidFields(schema, data)).toBe(0)
  })

  it("should count invalid fields in simple schema", () => {
    const schema = ES.Struct({
      username: ES.String,
      age: ES.Number,
      email: ES.String,
    })

    const data = {
      username: 123, // Invalid: should be string
      age: "not a number", // Invalid: should be number
      email: "valid@example.com", // Valid
    }

    expect(countInvalidFields(schema, data)).toBe(2)
  })

  it("should return 0 when all required fields are present", () => {
    const schema = ES.Struct({
      username: ES.String,
      email: ES.String,
    })

    const data = {
      username: "john",
      email: "john@example.com",
    }

    expect(countInvalidFields(schema, data)).toBe(0)
  })

  it("should count missing required fields as invalid", () => {
    const schema = ES.Struct({
      username: ES.String,
      email: ES.String,
      age: ES.Number,
    })

    const data = {
      username: "john",
      // email missing
      // age missing
    }

    expect(countInvalidFields(schema, data)).toBe(2)
  })

  it("should handle empty data with required fields", () => {
    const schema = ES.Struct({
      username: ES.String,
      email: ES.String,
    })

    const data = {}

    expect(countInvalidFields(schema, data)).toBe(2)
  })

  it("should return 0 for empty schema with empty data", () => {
    const schema = ES.Struct({})

    const data = {}

    expect(countInvalidFields(schema, data)).toBe(0)
  })

  it("should handle optional fields correctly", () => {
    const schema = ES.Struct({
      username: ES.String,
      email: ES.optional(ES.String),
      age: ES.optional(ES.Number),
    })

    const data = {
      username: "john",
      // email and age not provided - should be valid since they're optional
    }

    expect(countInvalidFields(schema, data)).toBe(0)
  })

  it("should count invalid optional fields when provided with wrong type", () => {
    const schema = ES.Struct({
      username: ES.String,
      email: ES.optional(ES.String),
      age: ES.optional(ES.Number),
    })

    const data = {
      username: "john",
      email: 123, // Invalid: should be string or undefined
      age: "not a number", // Invalid: should be number or undefined
    }

    expect(countInvalidFields(schema, data)).toBe(2)
  })

  it("should ignore excess properties", () => {
    const schema = ES.Struct({
      username: ES.String,
    })

    const data = {
      username: "john",
      extraField: "extra",
      anotherExtra: 123,
    }

    // Excess properties should be ignored (onExcessProperty: "ignore")
    expect(countInvalidFields(schema, data)).toBe(0)
  })

  it("should handle nested struct validation", () => {
    const schema = ES.Struct({
      username: ES.String,
      address: ES.Struct({
        street: ES.String,
        city: ES.String,
      }),
    })

    const data = {
      username: "john",
      address: {
        street: "123 Main St",
        // city missing
      },
    }

    // The 'address' field is invalid because its nested structure is invalid
    expect(countInvalidFields(schema, data)).toBe(1)
  })

  it("should count only top-level invalid fields for nested errors", () => {
    const schema = ES.Struct({
      user: ES.Struct({
        name: ES.String,
        email: ES.String,
      }),
      settings: ES.Struct({
        theme: ES.String,
        notifications: ES.Boolean,
      }),
    })

    const data = {
      user: {
        name: "john",
        // email missing - makes 'user' invalid
      },
      settings: {
        // theme missing
        // notifications missing - makes 'settings' invalid
      },
    }

    // Only counts top-level fields that are invalid: 'user' and 'settings'
    expect(countInvalidFields(schema, data)).toBe(2)
  })

  it("should handle form helper fields", () => {
    const schema = ES.Struct({
      username: TextField({ label: "Username" }),
      age: NumberField({ label: "Age" }),
      acceptTerms: BooleanField({ label: "Accept" }),
    })

    const data = {
      username: "john",
      age: 25,
      // acceptTerms missing
    }

    expect(countInvalidFields(schema, data)).toBe(1)
  })

  it("should reject empty strings when minLength constraint is applied", () => {
    const schema = ES.Struct({
      username: ES.String.pipe(ES.minLength(1)),
      email: ES.String.pipe(ES.minLength(5)),
      description: ES.String, // No minLength constraint
    })

    const data = {
      username: "", // Invalid: empty string violates minLength(1)
      email: "", // Invalid: empty string violates minLength(5)
      description: "", // Valid: no constraint
    }

    expect(countInvalidFields(schema, data)).toBe(2)
  })

  it("should accept non-empty strings that meet minLength requirement", () => {
    const schema = ES.Struct({
      username: ES.String.pipe(ES.minLength(3)),
      email: ES.String.pipe(ES.minLength(5)),
    })

    const data = {
      username: "john", // Valid: 4 characters >= 3
      email: "j@x.co", // Valid: 6 characters >= 5
    }

    expect(countInvalidFields(schema, data)).toBe(0)
  })

  it("should reject strings below minLength threshold", () => {
    const schema = ES.Struct({
      username: ES.String.pipe(ES.minLength(5)),
      email: ES.String.pipe(ES.minLength(10)),
    })

    const data = {
      username: "bob", // Invalid: 3 characters < 5
      email: "test@x.co", // Invalid: 9 characters < 10
    }

    expect(countInvalidFields(schema, data)).toBe(2)
  })
})

describe("calculateFieldCompletion", () => {
  it("should calculate completion for simple valid data", () => {
    const schema = ES.Struct({
      username: ES.String,
      email: ES.String,
      age: ES.Number,
    })

    const data = {
      username: "john",
      email: "john@example.com",
      age: 25,
    }

    expect(calculateFieldCompletion(schema, data)).toEqual({
      fieldsCompleted: 3,
      totalFields: 3,
    })
  })

  it("should calculate completion with some invalid fields", () => {
    const schema = ES.Struct({
      username: ES.String,
      email: ES.String,
      age: ES.Number,
    })

    const data = {
      username: "john",
      // email missing
      age: "invalid", // Invalid type
    }

    expect(calculateFieldCompletion(schema, data)).toEqual({
      fieldsCompleted: 1, // Only username is valid
      totalFields: 3,
    })
  })

  it("should calculate completion with all fields invalid", () => {
    const schema = ES.Struct({
      username: ES.String,
      email: ES.String,
    })

    const data = {}

    expect(calculateFieldCompletion(schema, data)).toEqual({
      fieldsCompleted: 0,
      totalFields: 2,
    })
  })

  it("should calculate completion for empty schema", () => {
    const schema = ES.Struct({})

    const data = {}

    expect(calculateFieldCompletion(schema, data)).toEqual({
      fieldsCompleted: 0,
      totalFields: 0,
    })
  })

  it("should calculate completion with all optional fields omitted", () => {
    const schema = ES.Struct({
      username: ES.optional(ES.String),
      email: ES.optional(ES.String),
      age: ES.optional(ES.Number),
    })

    const data = {}

    // All fields are optional and not provided - all valid
    expect(calculateFieldCompletion(schema, data)).toEqual({
      fieldsCompleted: 3,
      totalFields: 3,
    })
  })

  it("should calculate completion with mix of required and optional fields", () => {
    const schema = ES.Struct({
      username: ES.String, // Required
      email: ES.optional(ES.String), // Optional
      age: ES.Number, // Required
    })

    const data = {
      username: "john",
      // email omitted (valid - optional)
      // age missing (invalid - required)
    }

    expect(calculateFieldCompletion(schema, data)).toEqual({
      fieldsCompleted: 2, // username and email are valid
      totalFields: 3,
    })
  })

  it("should handle structural elements in completion calculation", () => {
    const schema = ES.Struct({
      title: TextBlock("Welcome"),
      username: ES.String,
      divider: Divider,
      email: ES.String,
    })

    const data = {
      username: "john",
      email: "john@example.com",
      // Structural elements (title, divider) are present in schema but not in data
      // They should validate successfully since they're Undefined schemas
    }

    const result = calculateFieldCompletion(schema, data)

    // All fields should be completed:
    // - username: valid
    // - email: valid
    // - title: Undefined schema validates successfully with undefined data
    // - divider: Undefined schema validates successfully with undefined data
    expect(result.fieldsCompleted).toBe(4)
    expect(result.totalFields).toBe(4)
  })

  it("should handle wrapper fields in completion calculation", () => {
    const schema = ES.Struct({
      username: ES.String,
      address: Wrapper({
        street: ES.String,
        city: ES.String,
      }),
    })

    const data = {
      username: "john",
      street: "123 Main St",
      city: "Springfield",
    }

    // Wrapper flattens the fields, but at the schema level we have:
    // - username (required)
    // - address (a Struct, required)
    const result = calculateFieldCompletion(schema, data)

    // username is valid, but address wrapper expects a struct, not flattened fields
    // So address field will be invalid
    expect(result.totalFields).toBe(2)
    expect(result.fieldsCompleted).toBe(1) // Only username
  })

  it("should handle wrapper fields with correct structure", () => {
    const schema = ES.Struct({
      username: ES.String,
      address: Wrapper({
        street: ES.String,
        city: ES.String,
      }),
    })

    const data = {
      username: "john",
      address: {
        street: "123 Main St",
        city: "Springfield",
      },
    }

    const result = calculateFieldCompletion(schema, data)

    expect(result.fieldsCompleted).toBe(2)
    expect(result.totalFields).toBe(2)
  })

  it("should handle form helpers with mixed valid and invalid data", () => {
    const schema = ES.Struct({
      username: TextField({ label: "Username" }),
      age: NumberField({ label: "Age" }),
      email: TextField({ label: "Email" }),
      acceptTerms: BooleanField({ label: "Accept" }),
    })

    const data = {
      username: "john",
      age: 25,
      email: "invalid-email", // Valid as string (email validation would be additional constraint)
      // acceptTerms missing
    }

    expect(calculateFieldCompletion(schema, data)).toEqual({
      fieldsCompleted: 3,
      totalFields: 4,
    })
  })

  it("should handle nested structs in completion calculation", () => {
    const schema = ES.Struct({
      username: ES.String,
      address: ES.Struct({
        street: ES.String,
        city: ES.String,
      }),
      settings: ES.Struct({
        theme: ES.String,
        notifications: ES.Boolean,
      }),
    })

    const data = {
      username: "john",
      address: {
        street: "123 Main St",
        city: "Springfield",
      },
      settings: {
        theme: "dark",
        // notifications missing
      },
    }

    // Top-level fields: username (valid), address (valid), settings (invalid)
    expect(calculateFieldCompletion(schema, data)).toEqual({
      fieldsCompleted: 2,
      totalFields: 3,
    })
  })

  it("should show all fields completed when all are optional and none provided", () => {
    const schema = ES.Struct({
      optionalField1: ES.optional(ES.String),
      optionalField2: ES.optional(ES.Number),
      optionalField3: ES.optional(ES.Boolean),
    })

    const data = {}

    // Everything is optional and valid when omitted
    expect(calculateFieldCompletion(schema, data)).toEqual({
      fieldsCompleted: 3,
      totalFields: 3,
    })
  })

  it("should calculate completion with string length constraints", () => {
    const schema = ES.Struct({
      username: ES.String.pipe(ES.minLength(3)),
      email: ES.String.pipe(ES.minLength(5)),
      description: ES.String, // No constraint
    })

    const data = {
      username: "jo", // Invalid: 2 characters < 3
      email: "test@example.com", // Valid: meets minLength(5)
      description: "", // Valid: no constraint
    }

    expect(calculateFieldCompletion(schema, data)).toEqual({
      fieldsCompleted: 2,
      totalFields: 3,
    })
  })

  it("should show completion with all fields having valid string constraints", () => {
    const schema = ES.Struct({
      username: ES.String.pipe(ES.minLength(1)),
      password: ES.String.pipe(ES.minLength(8)),
      confirmPassword: ES.String.pipe(ES.minLength(8)),
    })

    const data = {
      username: "john",
      password: "secretpassword",
      confirmPassword: "secretpassword",
    }

    expect(calculateFieldCompletion(schema, data)).toEqual({
      fieldsCompleted: 3,
      totalFields: 3,
    })
  })

  it("should show incomplete when empty strings violate minLength constraints", () => {
    const schema = ES.Struct({
      firstName: ES.String.pipe(ES.minLength(1)),
      lastName: ES.String.pipe(ES.minLength(1)),
      middleName: ES.String.pipe(ES.minLength(1)),
    })

    const data = {
      firstName: "",
      lastName: "Doe",
      middleName: "",
    }

    expect(calculateFieldCompletion(schema, data)).toEqual({
      fieldsCompleted: 1,
      totalFields: 3,
    })
  })
})
