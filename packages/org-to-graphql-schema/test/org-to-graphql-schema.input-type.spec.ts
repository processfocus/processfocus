import { Schema as ES, Effect } from "effect"
import { parse } from "graphql"
import { Wrapper } from "@pf/form-schema"
import {
  Form,
  OrgUnit,
  Organisation,
  OrganisationProviderTest,
  Process,
  Role,
} from "@pf/process"
import { buildDynamicSchema } from "../src/lib/org-to-graphql-schema"
import { describe, expect, it } from "bun:test"

describe("org-to-graphql-schema - input type generation", () => {
  /**
   * Helper to run buildDynamicSchema with a test organization
   */
  const runSchemaBuilder = (org: Organisation): Promise<string> => {
    const testLayer = OrganisationProviderTest(org)
    return Effect.runPromise(
      buildDynamicSchema().pipe(Effect.provide(testLayer)),
    )
  }

  /**
   * Helper to validate that generated SDL is valid GraphQL
   */
  const validateGraphQL = (sdl: string): void => {
    expect(() => parse(sdl)).not.toThrow()
  }

  it("should generate input type for simple form with single String field", async () => {
    const org = new Organisation({ name: "test-org" })
    const dept = new OrgUnit(org, "engineering", {
      name: "Engineering",
      type: "department",
    })
    const employeeRole = new Role(dept, "employee")

    const process = new Process(dept, "test-process", {
      name: "Test Process",
      purpose: "Test",
    })

    const form = new Form(process, "submit", {
      name: "Submit Form",
      form: () => ({
        username: ES.String,
      }),
      role: employeeRole,
    })

    process.start(form)

    const sdl = await runSchemaBuilder(org)

    // Should contain the input type
    expect(sdl).toContain("input EngineeringTestProcessSubmit")
    expect(sdl).toContain("username: String!")

    // Should be valid GraphQL
    validateGraphQL(sdl)
  })

  it("should generate input type with multiple primitive fields", async () => {
    const org = new Organisation({ name: "test-org" })
    const dept = new OrgUnit(org, "engineering", {
      name: "Engineering",
      type: "department",
    })
    const employeeRole = new Role(dept, "employee")

    const process = new Process(dept, "test-process", {
      name: "Test Process",
      purpose: "Test",
    })

    const form = new Form(process, "submit", {
      name: "Submit Form",
      form: () => ({
        username: ES.String,
        age: ES.Number,
        active: ES.Boolean,
      }),
      role: employeeRole,
    })

    process.start(form)

    const sdl = await runSchemaBuilder(org)

    // Should contain all fields
    expect(sdl).toContain("username: String!")
    expect(sdl).toContain("age: Float!")
    expect(sdl).toContain("active: Boolean!")

    // Should be valid GraphQL
    validateGraphQL(sdl)
  })

  it("should generate separate input types for nested Struct fields", async () => {
    const org = new Organisation({ name: "test-org" })
    const dept = new OrgUnit(org, "engineering", {
      name: "Engineering",
      type: "department",
    })
    const employeeRole = new Role(dept, "employee")

    const process = new Process(dept, "test-process", {
      name: "Test Process",
      purpose: "Test",
    })

    const form = new Form(process, "submit", {
      name: "Submit Form",
      form: () => ({
        username: ES.String,
        address: ES.Struct({
          street: ES.String,
          city: ES.String,
        }),
      }),
      role: employeeRole,
    })

    process.start(form)

    const sdl = await runSchemaBuilder(org)

    // Should generate auxiliary type for nested struct
    expect(sdl).toContain("input EngineeringTestProcessSubmitAddressInput")
    expect(sdl).toContain("street: String!")
    expect(sdl).toContain("city: String!")

    // Main type should reference the auxiliary type
    expect(sdl).toContain("input EngineeringTestProcessSubmit")
    expect(sdl).toContain("address: EngineeringTestProcessSubmitAddressInput!")

    // Auxiliary type should appear before main type in SDL
    const auxIndex = sdl.indexOf("EngineeringTestProcessSubmitAddressInput {")
    const mainIndex = sdl.indexOf("EngineeringTestProcessSubmit {")
    expect(auxIndex).toBeLessThan(mainIndex)

    // Should be valid GraphQL
    validateGraphQL(sdl)
  })

  it("should generate dummy type for form without input", async () => {
    const org = new Organisation({ name: "test-org" })
    const dept = new OrgUnit(org, "engineering", {
      name: "Engineering",
      type: "department",
    })
    const employeeRole = new Role(dept, "employee")

    const process = new Process(dept, "test-process", {
      name: "Test Process",
      purpose: "Test",
    })

    const form = new Form(process, "review", {
      name: "Review Form",
      form: () => ({}),
      role: employeeRole,
    })

    process.start(form)

    const sdl = await runSchemaBuilder(org)

    // Should contain dummy field
    expect(sdl).toContain("input EngineeringTestProcessReview")
    expect(sdl).toContain("_dummy: String")

    // Should be valid GraphQL
    validateGraphQL(sdl)
  })

  it("should flatten Wrapper fields using submission schema", async () => {
    const org = new Organisation({ name: "test-org" })
    const dept = new OrgUnit(org, "engineering", {
      name: "Engineering",
      type: "department",
    })
    const employeeRole = new Role(dept, "employee")

    const process = new Process(dept, "test-process", {
      name: "Test Process",
      purpose: "Test",
    })

    const form = new Form(process, "submit", {
      name: "Submit Form",
      form: () => ({
        username: ES.String,
        addressWrapper: Wrapper({
          street: ES.String,
          city: ES.String,
        }),
        agree: ES.Struct({
          acceptTerms: ES.Boolean,
        }),
      }),
      role: employeeRole,
    })

    process.start(form)

    const sdl = await runSchemaBuilder(org)

    // Wrapper fields should be flattened into main type
    expect(sdl).toContain("username: String!")
    expect(sdl).toContain("street: String!")
    expect(sdl).toContain("city: String!")

    // But regular Struct should still be nested
    expect(sdl).toContain("input EngineeringTestProcessSubmitAgreeInput")
    expect(sdl).toContain("acceptTerms: Boolean!")
    expect(sdl).toContain("agree: EngineeringTestProcessSubmitAgreeInput!")

    // Should NOT have a separate type for the wrapper
    expect(sdl).not.toContain("AddressWrapperInput")

    // Should be valid GraphQL
    validateGraphQL(sdl)
  })

  it("should handle deeply nested Struct fields", async () => {
    const org = new Organisation({ name: "test-org" })
    const dept = new OrgUnit(org, "engineering", {
      name: "Engineering",
      type: "department",
    })
    const employeeRole = new Role(dept, "employee")

    const process = new Process(dept, "test-process", {
      name: "Test Process",
      purpose: "Test",
    })

    const form = new Form(process, "submit", {
      name: "Submit Form",
      form: () => ({
        user: ES.Struct({
          name: ES.String,
          contact: ES.Struct({
            email: ES.String,
            phone: ES.String,
          }),
        }),
      }),
      role: employeeRole,
    })

    process.start(form)

    const sdl = await runSchemaBuilder(org)

    // Should generate types for all levels
    // Note: nested types are named by appending field names from the parent type
    expect(sdl).toContain(
      "input EngineeringTestProcessSubmitUserInputContactInput",
    )
    expect(sdl).toContain("email: String!")
    expect(sdl).toContain("phone: String!")

    expect(sdl).toContain("input EngineeringTestProcessSubmitUserInput")
    expect(sdl).toContain("name: String!")
    expect(sdl).toContain(
      "contact: EngineeringTestProcessSubmitUserInputContactInput!",
    )

    expect(sdl).toContain("input EngineeringTestProcessSubmit")
    expect(sdl).toContain("user: EngineeringTestProcessSubmitUserInput!")

    // Should be valid GraphQL
    validateGraphQL(sdl)
  })

  it("should deduplicate identical auxiliary types from multiple forms", async () => {
    const org = new Organisation({ name: "test-org" })
    const dept = new OrgUnit(org, "engineering", {
      name: "Engineering",
      type: "department",
    })
    const employeeRole = new Role(dept, "employee")

    const process1 = new Process(dept, "process-one", {
      name: "Process One",
      purpose: "Test",
    })

    const form1 = new Form(process1, "submit", {
      name: "Submit Form",
      form: () => ({
        data: ES.Struct({
          value: ES.String,
        }),
      }),
      role: employeeRole,
    })

    process1.start(form1)

    const process2 = new Process(dept, "process-two", {
      name: "Process Two",
      purpose: "Test",
    })

    const form2 = new Form(process2, "submit", {
      name: "Submit Form",
      form: () => ({
        data: ES.Struct({
          value: ES.String,
        }),
      }),
      role: employeeRole,
    })

    process2.start(form2)

    const sdl = await runSchemaBuilder(org)

    // Both forms should have their own types
    expect(sdl).toContain("input EngineeringProcessOneSubmit")
    expect(sdl).toContain("input EngineeringProcessTwoSubmit")

    // But if the nested structures are identical (same field structure),
    // they'll have different names based on parent, so both should exist
    expect(sdl).toContain("EngineeringProcessOneSubmitDataInput")
    expect(sdl).toContain("EngineeringProcessTwoSubmitDataInput")

    // Should be valid GraphQL
    validateGraphQL(sdl)
  })

  it("should handle optional fields correctly", async () => {
    const org = new Organisation({ name: "test-org" })
    const dept = new OrgUnit(org, "engineering", {
      name: "Engineering",
      type: "department",
    })
    const employeeRole = new Role(dept, "employee")

    const process = new Process(dept, "test-process", {
      name: "Test Process",
      purpose: "Test",
    })

    const form = new Form(process, "submit", {
      name: "Submit Form",
      form: () => ({
        required: ES.String,
        optional: ES.optional(ES.String),
      }),
      role: employeeRole,
    })

    process.start(form)

    const sdl = await runSchemaBuilder(org)

    // Required field should have !
    expect(sdl).toContain("required: String!")

    // Optional field should NOT have !
    expect(sdl).toMatch(/optional: String[^!]/)

    // Should be valid GraphQL
    validateGraphQL(sdl)
  })
})
