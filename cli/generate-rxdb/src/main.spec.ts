import { Schema as ES, Effect, Exit } from "effect"
import { ExecutionSchema } from "@pf/rxdb-collections"
import { walkCollectionSchema } from "./walker"
import { describe, expect, it } from "bun:test"

describe("walkCollectionSchema", () => {
  describe("basic primitive types", () => {
    it("should handle String fields", () => {
      const schema = ES.Struct({ name: ES.String })
      const result = Effect.runSync(walkCollectionSchema(schema.ast))

      expect(result.fields).toHaveLength(1)
      expect(result.fields[0]).toEqual({
        name: "name",
        type: "String",
        nullable: false,
      })
    })

    it("should handle id fields as ID type", () => {
      const schema = ES.Struct({ id: ES.String })
      const result = Effect.runSync(walkCollectionSchema(schema.ast))

      expect(result.fields[0]).toEqual({
        name: "id",
        type: "ID",
        nullable: false,
      })
    })

    it("should handle Number fields as Float", () => {
      const schema = ES.Struct({ price: ES.Number })
      const result = Effect.runSync(walkCollectionSchema(schema.ast))

      expect(result.fields[0]).toEqual({
        name: "price",
        type: "Float",
        nullable: false,
      })
    })

    it("should handle Boolean fields", () => {
      const schema = ES.Struct({ active: ES.Boolean })
      const result = Effect.runSync(walkCollectionSchema(schema.ast))

      expect(result.fields[0]).toEqual({
        name: "active",
        type: "Boolean",
        nullable: false,
      })
    })

    it("should handle Unknown fields as JSON", () => {
      const schema = ES.Struct({ metadata: ES.Unknown })
      const result = Effect.runSync(walkCollectionSchema(schema.ast))

      expect(result.fields[0]).toEqual({
        name: "metadata",
        type: "JSON",
        nullable: false,
      })
    })
  })

  describe("branded and refined types", () => {
    it("should map Int to GraphQL Int", () => {
      const schema = ES.Struct({ count: ES.Int })
      const result = Effect.runSync(walkCollectionSchema(schema.ast))

      expect(result.fields[0]).toEqual({
        name: "count",
        type: "Int",
        nullable: false,
      })
    })

    it("should map DateTimeUtc to DateTimeISO", () => {
      const schema = ES.Struct({ createdAt: ES.DateTimeUtc })
      const result = Effect.runSync(walkCollectionSchema(schema.ast))

      expect(result.fields[0]).toEqual({
        name: "createdAt",
        type: "DateTimeISO",
        nullable: false,
      })
    })

    it("should map BigInt to String", () => {
      const schema = ES.Struct({ largeNumber: ES.BigInt })
      const result = Effect.runSync(walkCollectionSchema(schema.ast))

      expect(result.fields[0]).toEqual({
        name: "largeNumber",
        type: "String",
        nullable: false,
      })
    })
  })

  describe("optional fields", () => {
    it("should mark optional fields as nullable", () => {
      const schema = ES.Struct({
        name: ES.String,
        nickname: ES.optional(ES.String),
      })
      const result = Effect.runSync(walkCollectionSchema(schema.ast))

      expect(result.fields).toHaveLength(2)
      expect(result.fields[0]).toEqual({
        name: "name",
        type: "String",
        nullable: false,
      })
      expect(result.fields[1]).toEqual({
        name: "nickname",
        type: "String",
        nullable: true,
      })
    })

    it("should handle optional Int fields", () => {
      const schema = ES.Struct({
        score: ES.optional(ES.Int),
      })
      const result = Effect.runSync(walkCollectionSchema(schema.ast))

      expect(result.fields[0]).toEqual({
        name: "score",
        type: "Int",
        nullable: true,
      })
    })
  })

  describe("complex schemas", () => {
    it("should handle schemas with multiple field types", () => {
      const schema = ES.Struct({
        id: ES.String,
        name: ES.String,
        count: ES.Int,
        price: ES.Number,
        active: ES.Boolean,
        createdAt: ES.DateTimeUtc,
        metadata: ES.Unknown,
      })
      const result = Effect.runSync(walkCollectionSchema(schema.ast))

      expect(result.fields).toHaveLength(7)
      expect(result.fields[0]).toEqual({
        name: "id",
        type: "ID",
        nullable: false,
      })
      expect(result.fields[1]).toEqual({
        name: "name",
        type: "String",
        nullable: false,
      })
      expect(result.fields[2]).toEqual({
        name: "count",
        type: "Int",
        nullable: false,
      })
      expect(result.fields[3]).toEqual({
        name: "price",
        type: "Float",
        nullable: false,
      })
      expect(result.fields[4]).toEqual({
        name: "active",
        type: "Boolean",
        nullable: false,
      })
      expect(result.fields[5]).toEqual({
        name: "createdAt",
        type: "DateTimeISO",
        nullable: false,
      })
      expect(result.fields[6]).toEqual({
        name: "metadata",
        type: "JSON",
        nullable: false,
      })
    })
  })

  describe("Record types", () => {
    it("should map Record to JSON", () => {
      const schema = ES.Struct({
        state: ES.Record({ key: ES.String, value: ES.Unknown }),
      })
      const result = Effect.runSync(walkCollectionSchema(schema.ast))

      expect(result.fields[0]).toEqual({
        name: "state",
        type: "JSON",
        nullable: false,
      })
      expect(result.nestedTypes).toHaveLength(0)
    })
  })

  describe("nested struct types", () => {
    it("should generate nested type for nested Struct", () => {
      const OrgUnitSchema = ES.Struct({
        id: ES.String,
        name: ES.String,
        level: ES.String,
      })
      const schema = ES.Struct({
        id: ES.String,
        orgUnit: OrgUnitSchema,
      })
      const result = Effect.runSync(walkCollectionSchema(schema.ast, "Process"))

      expect(result.fields).toHaveLength(2)
      expect(result.fields[0]).toEqual({
        name: "id",
        type: "ID",
        nullable: false,
      })
      expect(result.fields[1]).toEqual({
        name: "orgUnit",
        type: "ProcessOrgUnit",
        nullable: false,
      })

      // Check nested type was generated
      expect(result.nestedTypes).toHaveLength(1)
      const nestedType = result.nestedTypes[0]
      expect(nestedType).toBeDefined()
      expect(nestedType?.name).toBe("ProcessOrgUnit")
      expect(nestedType?.fields).toHaveLength(3)
      expect(nestedType?.fields.find((f) => f.name === "id")).toEqual({
        name: "id",
        type: "ID",
        nullable: false,
      })
      expect(nestedType?.fields.find((f) => f.name === "name")).toEqual({
        name: "name",
        type: "String",
        nullable: false,
      })
      expect(nestedType?.fields.find((f) => f.name === "level")).toEqual({
        name: "level",
        type: "String",
        nullable: false,
      })
    })

    it("should handle optional nested Struct", () => {
      const AddressSchema = ES.Struct({
        street: ES.String,
        city: ES.String,
      })
      const schema = ES.Struct({
        address: ES.optional(AddressSchema),
      })
      const result = Effect.runSync(walkCollectionSchema(schema.ast, "Person"))

      expect(result.fields[0]).toEqual({
        name: "address",
        type: "PersonAddress",
        nullable: true,
      })
      expect(result.nestedTypes).toHaveLength(1)
    })
  })

  describe("error cases", () => {
    it("should fail for non-TypeLiteral AST nodes", () => {
      const schema = ES.String
      const result = Effect.runSyncExit(walkCollectionSchema(schema.ast))

      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        expect(result.cause._tag).toBe("Fail")
      }
    })
  })

  describe("real-world example", () => {
    it("should handle DraftProcessExecution schema from rxdb-collections", () => {
      const RxDbDocumentSchema = ES.Struct({
        id: ES.String,
        updatedAt: ES.Number,
        deleted: ES.Boolean,
      })

      const DraftProcessExecutionSchema = ES.Struct({
        ...RxDbDocumentSchema.fields,
        processId: ES.String,
        name: ES.String,
        state: ES.Unknown,
        fieldsCompleted: ES.Int,
        totalFields: ES.Int,
        lastSaved: ES.DateTimeUtc,
      })

      const result = Effect.runSync(
        walkCollectionSchema(DraftProcessExecutionSchema.ast),
      )

      expect(result.fields).toHaveLength(9)

      // Check base fields
      expect(result.fields.find((f) => f.name === "id")).toEqual({
        name: "id",
        type: "ID",
        nullable: false,
      })
      expect(result.fields.find((f) => f.name === "updatedAt")).toEqual({
        name: "updatedAt",
        type: "Float",
        nullable: false,
      })
      expect(result.fields.find((f) => f.name === "deleted")).toEqual({
        name: "deleted",
        type: "Boolean",
        nullable: false,
      })

      // Check process-specific fields
      expect(result.fields.find((f) => f.name === "processId")).toEqual({
        name: "processId",
        type: "String",
        nullable: false,
      })
      expect(result.fields.find((f) => f.name === "fieldsCompleted")).toEqual({
        name: "fieldsCompleted",
        type: "Int",
        nullable: false,
      })
      expect(result.fields.find((f) => f.name === "totalFields")).toEqual({
        name: "totalFields",
        type: "Int",
        nullable: false,
      })
      expect(result.fields.find((f) => f.name === "lastSaved")).toEqual({
        name: "lastSaved",
        type: "DateTimeISO",
        nullable: false,
      })
      expect(result.fields.find((f) => f.name === "state")).toEqual({
        name: "state",
        type: "JSON",
        nullable: false,
      })
    })

    it("maps execution durationMs to Float so multi-week durations fit GraphQL", () => {
      const result = Effect.runSync(walkCollectionSchema(ExecutionSchema.ast))

      expect(
        result.fields.find((field) => field.name === "durationMs"),
      ).toEqual({
        name: "durationMs",
        type: "Float",
        nullable: true,
      })
    })
  })
})
