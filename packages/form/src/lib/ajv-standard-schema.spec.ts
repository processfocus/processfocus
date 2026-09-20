import {
  type JsonSchemaRoot,
  createStandardSchemaFromJsonSchema,
} from "./ajv-standard-schema"
import {
  friendlyFormValidationMessage,
  friendlyJsonSchemaValidationMessage,
} from "./friendly-validation-message"
import { describe, expect, it } from "bun:test"

describe("createStandardSchemaFromJsonSchema", () => {
  it("should validate successfully with valid data", () => {
    const jsonSchema: JsonSchemaRoot = {
      type: "object",
      required: ["name", "age"],
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
    }
    const validator = createStandardSchemaFromJsonSchema(jsonSchema)

    const result = validator["~standard"].validate({
      name: "John Doe",
      age: 30,
    })

    expect(result).toEqual({
      value: {
        name: "John Doe",
        age: 30,
      },
      issues: undefined,
    })
  })

  it("should reject validation with invalid data and return issues", () => {
    const jsonSchema: JsonSchemaRoot = {
      type: "object",
      required: ["name", "age"],
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
    }
    const validator = createStandardSchemaFromJsonSchema(jsonSchema)

    const result = validator["~standard"].validate({
      name: "John Doe",
      age: "not a number",
    })

    // Assert result is not a Promise (our implementation is synchronous)
    if (result instanceof Promise) {
      throw new Error("Expected synchronous result")
    }

    expect(result.issues).toBeDefined()
    expect(result.issues?.length).toBeGreaterThan(0)

    if (!result.issues || result.issues.length === 0) {
      throw new Error("Expected issues to be defined and non-empty")
    }

    const firstIssue = result.issues[0]
    if (!firstIssue) {
      throw new Error("Expected first issue to exist")
    }

    expect(firstIssue.path).toEqual(["age"])
    expect(firstIssue.message).toBeDefined()
  })

  it("should report the missing field path for required errors", () => {
    const jsonSchema: JsonSchemaRoot = {
      type: "object",
      required: ["name", "age"],
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
    }
    const validator = createStandardSchemaFromJsonSchema(jsonSchema)

    const result = validator["~standard"].validate({
      name: "John Doe",
    })

    if (result instanceof Promise) {
      throw new Error("Expected synchronous result")
    }

    expect(result.issues).toBeDefined()

    if (!result.issues || result.issues.length === 0) {
      throw new Error("Expected issues to be defined and non-empty")
    }

    const requiredIssue = result.issues.find(
      (issue) => issue.path?.join(".") === "age",
    )

    expect(requiredIssue).toBeDefined()
    expect(requiredIssue?.message).toBe("This field is required.")
  })

  it("should report empty strings as required fields", () => {
    const jsonSchema: JsonSchemaRoot = {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", minLength: 1 },
      },
    }

    const validator = createStandardSchemaFromJsonSchema(jsonSchema)

    const result = validator["~standard"].validate({ name: "" })

    if (result instanceof Promise) {
      throw new Error("Expected synchronous result")
    }

    expect(result.issues?.[0]?.message).toBe("This field is required.")
  })

  it("should report invalid email format with friendly copy", () => {
    const jsonSchema: JsonSchemaRoot = {
      type: "object",
      required: ["email"],
      properties: {
        email: { type: "string", format: "email" },
      },
    }

    const validator = createStandardSchemaFromJsonSchema(jsonSchema)

    const result = validator["~standard"].validate({ email: "not an email" })

    if (result instanceof Promise) {
      throw new Error("Expected synchronous result")
    }

    expect(result.issues?.[0]?.message).toBe(
      "Please enter a valid email address.",
    )
  })

  it("should report phone format errors with friendly copy", () => {
    const jsonSchema: JsonSchemaRoot = {
      type: "object",
      required: ["phoneNumber"],
      properties: {
        phoneNumber: { type: "string", format: "phone" },
      },
    }

    const validator = createStandardSchemaFromJsonSchema(jsonSchema)

    const result = validator["~standard"].validate({ phoneNumber: "123" })
    const multiplePlusResult = validator["~standard"].validate({
      phoneNumber: "++1234567890",
    })

    if (result instanceof Promise || multiplePlusResult instanceof Promise) {
      throw new Error("Expected synchronous result")
    }

    expect(result.issues?.[0]?.message).toBe(
      "Please enter a valid phone number.",
    )
    expect(multiplePlusResult.issues?.[0]?.message).toBe(
      "Please enter a valid phone number.",
    )
  })

  it("should report required checkboxes with friendly copy", () => {
    const jsonSchema: JsonSchemaRoot = {
      type: "object",
      required: ["accepted"],
      properties: {
        accepted: { type: "boolean", enum: [true] },
      },
    }

    const validator = createStandardSchemaFromJsonSchema(jsonSchema)

    const result = validator["~standard"].validate({ accepted: false })

    if (result instanceof Promise) {
      throw new Error("Expected synchronous result")
    }

    expect(result.issues?.[0]?.message).toBe("This field is required.")
  })

  it("should allow compiling the same generated schema more than once", () => {
    const jsonSchema: JsonSchemaRoot = { type: "object", properties: {} }

    const first = createStandardSchemaFromJsonSchema(jsonSchema)
    const second = createStandardSchemaFromJsonSchema(jsonSchema)

    expect(first["~standard"].validate({})).toEqual({
      value: {},
      issues: undefined,
    })
    expect(second["~standard"].validate({})).toEqual({
      value: {},
      issues: undefined,
    })
  })
})

describe("friendly validation messages", () => {
  it("should preserve unrecognized validation messages", () => {
    expect(
      friendlyJsonSchemaValidationMessage({
        keyword: "pattern",
        message: "must match pattern ^[a-z]+$",
      }),
    ).toBe("must match pattern ^[a-z]+$")
  })

  it("should normalize external participant email required messages", () => {
    expect(
      friendlyFormValidationMessage("External participant email is required"),
    ).toBe("This field is required.")
  })
})
