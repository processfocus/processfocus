import { Schema as ES } from "effect"
import { calculateFieldCompletion, countInvalidFields } from "./field-count"
import {
  BooleanField,
  Divider,
  NumberField,
  TextBlock,
  TextField,
  Wrapper,
} from "./form-schema"
import { describe, expect, it } from "bun:test"

describe("countInvalidFields", () => {
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

  it("should calculate completion with string length constraints", () => {
    const schema = ES.Struct({
      username: ES.String.pipe(ES.check(ES.isMinLength(3))),
      email: ES.String.pipe(ES.check(ES.isMinLength(5))),
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
      username: ES.String.pipe(ES.check(ES.isMinLength(1))),
      password: ES.String.pipe(ES.check(ES.isMinLength(8))),
      confirmPassword: ES.String.pipe(ES.check(ES.isMinLength(8))),
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
      firstName: ES.String.pipe(ES.check(ES.isMinLength(1))),
      lastName: ES.String.pipe(ES.check(ES.isMinLength(1))),
      middleName: ES.String.pipe(ES.check(ES.isMinLength(1))),
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
