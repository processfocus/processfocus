import { Schema as ES, JSONSchema } from "effect"
import { BooleanField, NumberFieldFrom } from "./form-schema"
import { describe, expect, it } from "bun:test"

describe("NumberFieldFrom required validation", () => {
  it("should generate JSON Schema with minLength when required is true", () => {
    const schema = ES.Struct({
      age: NumberFieldFrom(ES.NumberFromString, {
        label: "Age",
        required: true,
      }),
    })

    const jsonSchema = JSONSchema.make(schema) as unknown as {
      required?: string[]
      properties: { age: { type: string; minLength?: number } }
    }

    // Should have required array
    expect(jsonSchema.required).toContain("age")

    // Should have minLength constraint for AJV validation
    expect(jsonSchema.properties.age.minLength).toBe(1)
  })

  it("should fail Effect Schema validation on empty string when required is true", () => {
    const schema = ES.Struct({
      age: NumberFieldFrom(ES.NumberFromString, {
        label: "Age",
        required: true,
      }),
    })

    // Try to decode an empty string - should fail
    const result = ES.decodeUnknownEither(schema)(
      { age: "" },
      { errors: "all" },
    )

    expect(result._tag).toBe("Left")
  })

  it("should succeed Effect Schema validation with valid number when required is true", () => {
    const schema = ES.Struct({
      age: NumberFieldFrom(ES.NumberFromString, {
        label: "Age",
        required: true,
      }),
    })

    // Try to decode a valid number string - should succeed
    const result = ES.decodeUnknownEither(schema)(
      { age: "42" },
      { errors: "all" },
    )

    expect(result._tag).toBe("Right")
    if (result._tag === "Right") {
      expect(result.right.age).toBe(42)
    }
  })

  it("should compare with BooleanField required behavior", () => {
    const boolSchema = ES.Struct({
      approved: BooleanField({ label: "Approved", required: true }),
    })

    const jsonSchema = JSONSchema.make(boolSchema) as unknown as {
      required?: string[]
      properties: { approved: { type: string; enum?: boolean[] } }
    }

    expect(jsonSchema.required).toContain("approved")
    expect(jsonSchema.properties.approved.enum).toEqual([true])
  })

  it("should not have minLength when required is not set", () => {
    const schema = ES.Struct({
      age: NumberFieldFrom(ES.NumberFromString, { label: "Age" }),
    })

    const jsonSchema = JSONSchema.make(schema) as unknown as {
      required?: string[]
      properties: { age: { type: string; minLength?: number } }
    }

    // Should not have minLength when optional (but field is still required by Effect Schema for transformation)
    expect(jsonSchema.properties.age.minLength).toBeUndefined()
    // Note: NumberFromString fields are always in 'required' because Effect Schema needs a value to transform
    // The difference is that without required: true, empty string won't fail AJV validation
  })
})
