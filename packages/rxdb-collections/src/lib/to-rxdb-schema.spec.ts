import { Schema as ES } from "effect"
import { DraftProcessExecutionSchema } from "./rxdb-collections"
import {
  toRxDbJsonSchema,
  toRxDbProperties,
  toRxDbProperty,
} from "./to-rxdb-schema"
import { describe, expect, it } from "bun:test"

describe("toRxDbProperty", () => {
  it("converts unknown type ($id: /schemas/unknown) to object type", () => {
    const unknownProp = {
      $id: "/schemas/unknown",
      title: "unknown",
    }

    const result = toRxDbProperty(unknownProp)

    // Object type accepts any JSON value
    expect(result).toEqual({ type: "object" })
  })

  it("removes $id, title, and description from properties", () => {
    const prop = {
      $id: "some-id",
      title: "Some Title",
      description: "Some description",
      type: "string",
      maxLength: 10,
    }

    const result = toRxDbProperty(prop)

    expect(result).toEqual({
      type: "string",
      maxLength: 10,
    })
  })

  it("preserves other properties when removing metadata", () => {
    const prop = {
      $id: "test",
      type: "number",
      minimum: 0,
      maximum: 100,
    }

    const result = toRxDbProperty(prop)

    expect(result).toEqual({
      type: "number",
      minimum: 0,
      maximum: 100,
    })
  })

  it("drops Effect's safe-integer bounds but keeps explicit bounds", () => {
    expect(
      toRxDbProperty({
        type: "integer",
        minimum: Number.MIN_SAFE_INTEGER,
        maximum: Number.MAX_SAFE_INTEGER,
      }),
    ).toEqual({ type: "integer" })

    expect(
      toRxDbProperty({
        type: "integer",
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
      }),
    ).toEqual({ type: "integer", minimum: 0 })
  })
})

describe("toRxDbProperties", () => {
  it("inlines $ref references from $defs", () => {
    const properties = {
      myField: { $ref: "#/$defs/MyType" },
    }
    const defs = {
      MyType: { type: "string", maxLength: 50 },
    }

    const result = toRxDbProperties(properties, defs)

    expect(result).toEqual({
      myField: { type: "string", maxLength: 50 },
    })
  })

  it("cleans inlined $ref definitions", () => {
    const properties = {
      myField: { $ref: "#/$defs/MyType" },
    }
    const defs = {
      MyType: { $id: "some-id", title: "My Type", type: "string" },
    }

    const result = toRxDbProperties(properties, defs)

    expect(result).toEqual({
      myField: { type: "string" },
    })
  })

  it("handles missing $ref definition gracefully", () => {
    const properties = {
      myField: { $ref: "#/$defs/NonExistent" },
    }
    const defs = {}

    const result = toRxDbProperties(properties, defs)

    // Should clean the $ref itself when definition not found
    expect(result).toEqual({
      myField: {},
    })
  })

  it("processes non-object values unchanged", () => {
    const properties = {
      primitiveField: "string-value",
      nullField: null,
    }

    const result = toRxDbProperties(properties, {})

    expect(result).toEqual({
      primitiveField: "string-value",
      nullField: null,
    })
  })
})

describe("toRxDbJsonSchema", () => {
  it("converts DraftProcessExecutionSchema to RxDB-compatible format", () => {
    const result = toRxDbJsonSchema(DraftProcessExecutionSchema)

    // Note: _deleted is excluded because RxDB handles it internally via deletedField config
    expect(result).toEqual({
      properties: {
        id: {
          type: "string",
          maxLength: 41,
        },
        updatedAt: {
          type: "number",
        },
        processId: {
          type: "string",
        },
        name: {
          type: "string",
        },
        startStepPath: {
          type: "string",
        },
        state: {
          type: "object",
          required: [],
          properties: {},
        },
        fieldsCompleted: {
          type: "integer",
        },
        totalFields: {
          type: "integer",
        },
        lastSaved: {
          type: "string",
        },
      },
      required: [
        "id",
        "updatedAt",
        "processId",
        "name",
        "startStepPath",
        "state",
        "fieldsCompleted",
        "totalFields",
        "lastSaved",
      ],
    })
  })

  it("handles optional fields correctly (nullable type, not in required array)", () => {
    const TestSchema = ES.Struct({
      id: ES.String,
      requiredField: ES.Number,
      optionalField: ES.optional(ES.Number),
    })

    const result = toRxDbJsonSchema(TestSchema)

    // Optional field should have nullable type to accept null from GraphQL
    expect(result.properties["optionalField"]).toEqual({
      type: ["number", "null"],
    })
    expect(result.required).toEqual(["id", "requiredField"])
    expect(result.required).not.toContain("optionalField")
  })
})

describe("collection JSON schema", () => {
  it("inlines date-time definitions into replication fields", () => {
    const generated = toRxDbJsonSchema(DraftProcessExecutionSchema)
    expect(generated.properties["lastSaved"]).toMatchObject({ type: "string" })
    expect(generated.properties["lastSaved"]).not.toHaveProperty("$ref")
  })
})
