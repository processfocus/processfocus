import { Schema as ES } from "effect"
import { Form, countLeafFields } from "./form"
import { OrgUnit } from "./org-unit"
import { Organisation } from "./organisation"
import { Process } from "./process"
import { Role } from "./role"
import { beforeEach, describe, expect, it } from "bun:test"

describe("countLeafFields", () => {
  it("should return 0 for null or undefined", () => {
    expect(countLeafFields(null)).toBe(0)
    expect(countLeafFields(undefined)).toBe(0)
  })

  it("should return 1 for primitive values", () => {
    expect(countLeafFields("hello")).toBe(1)
    expect(countLeafFields(42)).toBe(1)
    expect(countLeafFields(true)).toBe(1)
    expect(countLeafFields(false)).toBe(1)
  })

  it("should return 1 for empty arrays", () => {
    expect(countLeafFields([])).toBe(1)
  })

  it("should return 0 for empty objects", () => {
    expect(countLeafFields({})).toBe(0)
  })

  it("should count leaf fields in flat objects", () => {
    expect(countLeafFields({ name: "", age: 0 })).toBe(2)
    expect(countLeafFields({ a: "", b: "", c: "" })).toBe(3)
  })

  it("should count leaf fields in nested objects", () => {
    expect(
      countLeafFields({
        person: {
          name: "",
          age: 0,
        },
      }),
    ).toBe(2)

    expect(
      countLeafFields({
        person: {
          name: "",
          address: {
            street: "",
            city: "",
          },
        },
      }),
    ).toBe(3)
  })

  it("should count leaf fields in arrays of primitives", () => {
    expect(countLeafFields(["a", "b", "c"])).toBe(3)
    expect(countLeafFields([1, 2, 3, 4, 5])).toBe(5)
  })

  it("should count leaf fields in arrays of objects", () => {
    expect(
      countLeafFields([
        { name: "", age: 0 },
        { name: "", age: 0 },
      ]),
    ).toBe(4)
  })

  it("should handle deeply nested structures", () => {
    expect(
      countLeafFields({
        level1: {
          level2: {
            level3: {
              field1: "",
              field2: 0,
            },
          },
          sibling: "",
        },
      }),
    ).toBe(3)
  })
})

describe("Form.totalFields", () => {
  let organisation: Organisation
  let orgUnit: OrgUnit
  let mockRole: Role

  beforeEach(() => {
    organisation = new Organisation({ name: "Test Organisation" })
    orgUnit = new OrgUnit(organisation, "test-unit", {
      name: "Test Unit",
      type: "department",
    })
    mockRole = new Role(orgUnit, "mock", { name: "Mock Role" })
  })

  it("should return 0 for form with empty fields", () => {
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const form = new Form(process, "submit", {
      role: mockRole,
      form: () => ({}),
    })

    expect(form.totalFields).toBe(0)
  })

  it("should return 0 for form function with empty fields", () => {
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const form = new Form(process, "submit", {
      role: mockRole,
      form: () => ({}),
    })

    expect(form.totalFields).toBe(0)
  })

  it("should count flat fields correctly", () => {
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const form = new Form(process, "submit", {
      role: mockRole,
      form: () => ({
        name: ES.String,
        age: ES.Number,
        active: ES.Boolean,
      }),
    })

    expect(form.totalFields).toBe(3)
  })

  it("should count nested struct fields as leaf fields", () => {
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const form = new Form(process, "submit", {
      role: mockRole,
      form: () => ({
        person: ES.Struct({
          firstName: ES.String,
          lastName: ES.String,
          age: ES.Number,
        }),
        active: ES.Boolean,
      }),
    })

    // person has 3 leaf fields (firstName, lastName, age), plus 1 for active = 4
    expect(form.totalFields).toBe(4)
  })

  it("should handle form function inputs", () => {
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const submitForm = new Form(process, "submit", {
      role: mockRole,
      form: () => ({
        name: ES.String,
      }),
    })

    const flow = process.start(submitForm)
    const approveForm = new Form(flow, "approve", {
      role: mockRole,
      form: () => ({
        displayName: ES.String,
        approved: ES.Boolean,
      }),
    })

    expect(approveForm.totalFields).toBe(2)
  })
})
