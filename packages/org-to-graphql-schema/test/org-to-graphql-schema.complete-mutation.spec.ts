import { Schema as ES, Effect } from "effect"
import { parse } from "graphql"
import { TextField } from "@pf/form-schema"
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

describe("org-to-graphql-schema - complete mutation generation", () => {
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

  it("should generate complete mutation with input for form with editable fields", async () => {
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

    const startForm = new Form(process, "start", {
      name: "Start",
      form: () => ({ name: ES.String }),
      role: employeeRole,
    })

    const editableForm = new Form(process, "review", {
      name: "Review",
      form: () => ({
        approved: ES.Boolean,
      }),
      role: employeeRole,
    })

    process.start(startForm).end(editableForm)

    const sdl = await runSchemaBuilder(org)

    // Should generate complete mutation with input parameter
    expect(sdl).toContain(
      "completeEngineeringTestProcessReview(todoId: ID!, input: EngineeringTestProcessReview!): CompleteStepPayload!",
    )

    // Input type should contain the editable field
    expect(sdl).toContain("input EngineeringTestProcessReview")
    expect(sdl).toContain("approved: Boolean!")

    validateGraphQL(sdl)
  })

  it("should generate complete mutation without input when all fields are read-only", async () => {
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

    const startForm = new Form(process, "start", {
      name: "Start",
      form: () => ({ value: ES.String }),
      role: employeeRole,
    })

    const readOnlyForm = new Form(process, "show-result", {
      name: "Show Result",
      form: () => ({
        result: TextField({ label: "Result", readOnly: true }),
        summary: TextField({ label: "Summary", readOnly: true }),
      }),
      role: employeeRole,
    })

    process.start(startForm).end(readOnlyForm)

    const sdl = await runSchemaBuilder(org)

    // Complete mutation should NOT have input parameter
    expect(sdl).toContain(
      "completeEngineeringTestProcessShowResult(todoId: ID!): CompleteStepPayload!",
    )

    // Should NOT have input parameter in the mutation
    expect(sdl).not.toContain(
      "completeEngineeringTestProcessShowResult(todoId: ID!, input:",
    )

    validateGraphQL(sdl)
  })

  it("should generate complete mutation with input when form has mix of editable and read-only fields", async () => {
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

    const startForm = new Form(process, "start", {
      name: "Start",
      form: () => ({ value: ES.String }),
      role: employeeRole,
    })

    const mixedForm = new Form(process, "confirm", {
      name: "Confirm",
      form: () => ({
        displayValue: TextField({ label: "Value", readOnly: true }),
        approved: ES.Boolean,
      }),
      role: employeeRole,
    })

    process.start(startForm).end(mixedForm)

    const sdl = await runSchemaBuilder(org)

    // Complete mutation should have input parameter
    expect(sdl).toContain(
      "completeEngineeringTestProcessConfirm(todoId: ID!, input: EngineeringTestProcessConfirm!): CompleteStepPayload!",
    )

    // Input type should only contain the editable field, not the read-only one
    expect(sdl).toContain("input EngineeringTestProcessConfirm")
    expect(sdl).toContain("approved: Boolean!")
    expect(sdl).not.toContain("displayValue")

    validateGraphQL(sdl)
  })

  it("should generate complete mutation without input for form with no fields", async () => {
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

    const startForm = new Form(process, "start", {
      name: "Start",
      form: () => ({ value: ES.String }),
      role: employeeRole,
    })

    const emptyForm = new Form(process, "acknowledge", {
      name: "Acknowledge",
      form: () => ({}),
      role: employeeRole,
    })

    process.start(startForm).end(emptyForm)

    const sdl = await runSchemaBuilder(org)

    // Complete mutation should NOT have input parameter
    expect(sdl).toContain(
      "completeEngineeringTestProcessAcknowledge(todoId: ID!): CompleteStepPayload!",
    )

    expect(sdl).not.toContain(
      "completeEngineeringTestProcessAcknowledge(todoId: ID!, input:",
    )

    validateGraphQL(sdl)
  })
})
