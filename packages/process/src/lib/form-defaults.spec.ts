import { DateTime, Schema as ES, Effect } from "effect"
import {
  CurrentProviderUser,
  FormDefault,
  ProviderUserField,
  TextField,
} from "@pf/form-schema"
import type { FlowContext } from "./flow-context"
import { Form } from "./form"
import { OrgUnit } from "./org-unit"
import { Organisation } from "./organisation"
import { Process } from "./process"
import { Role } from "./role"
import { beforeEach, describe, expect, it } from "bun:test"

// Empty context for tests that don't use context
const emptyCtx: FlowContext<Record<string, never>> = {
  process: {
    executionId: "pex-test",
    startedAt: DateTime.unsafeNow(),
    startStep: {
      user: { userId: "", sub: "" },
      providerUser: {
        id: "",
        name: "",
        firstName: "",
        lastName: "",
        email: "",
        picture: "",
      },
      completedAt: DateTime.unsafeNow(),
    },
  },
  step: {},
}

describe("Form.resolveDefaults", () => {
  let org: Organisation
  let role: Role
  let process: Process

  beforeEach(() => {
    org = new Organisation({ name: "Test Corp" })
    const dept = new OrgUnit(org, "dept", { name: "Dept", type: "department" })
    role = new Role(dept, "user", { name: "User" })
    process = new Process(dept, "test-process", {
      name: "Test Process",
      purpose: "Testing",
    })
  })

  it("should resolve static default values", async () => {
    const form = new Form(process, "test-form", {
      role,
      form: () => ({
        name: ES.String.annotations({ [FormDefault]: "John" }),
        age: ES.Number.annotations({ [FormDefault]: 25 }),
      }),
    })
    process.start(form)

    const defaults = form.defaults()
    expect(defaults["age"]).toBeDefined()
    expect(defaults["name"]).toBeDefined()

    const result = await Effect.runPromise(form.resolveDefaults({}, emptyCtx))

    expect(result).toMatchObject({
      name: "John",
      age: 25,
    })
  })

  it("should resolve default closures", async () => {
    // Simulate how Form with flow scope works: state is captured via closure
    const state = { firstName: "John", lastName: "Doe" }

    const form = new Form(process, "test-form", {
      role,
      form: () => ({
        summary: ES.String.annotations({
          [FormDefault]: () => `${state.firstName} ${state.lastName}`,
        }),
      }),
    })
    process.start(form)

    const result = await Effect.runPromise(form.resolveDefaults({}, emptyCtx))

    expect(result).toMatchObject({
      summary: "John Doe",
    })
  })

  it("should work with TextField helper", async () => {
    // Simulate closure capturing state from Form's form function
    const state = { dates: "2024-01-15" }

    const form = new Form(process, "test-form", {
      role,
      form: () => ({
        requestedDates: TextField({
          label: "Requested Dates",
          readOnly: true,
          default: () => state.dates,
        }),
      }),
    })
    process.start(form)

    const result = await Effect.runPromise(form.resolveDefaults({}, emptyCtx))

    expect(result).toMatchObject({
      requestedDates: "2024-01-15",
    })
  })

  it("should include schema defaults for fields without FormDefault annotation", async () => {
    const form = new Form(process, "test-form", {
      role,
      form: () => ({
        name: ES.String,
        withDefault: ES.String.annotations({ [FormDefault]: "default value" }),
      }),
    })
    process.start(form)

    const result = await Effect.runPromise(form.resolveDefaults({}, emptyCtx))

    // Schema defaults provide empty string for String fields
    expect(result).toMatchObject({
      name: "",
      withDefault: "default value",
    })
  })

  it("should skip fields where default function throws", async () => {
    const form = new Form(process, "test-form", {
      role,
      form: () => ({
        failing: ES.String.annotations({
          [FormDefault]: () => {
            throw new Error("boom")
          },
        }),
        working: ES.String.annotations({ [FormDefault]: "works" }),
      }),
    })
    process.start(form)

    // Should not throw, just skip the failing field
    const result = await Effect.runPromise(form.resolveDefaults({}, emptyCtx))

    expect(result).toMatchObject({
      working: "works",
    })
    // failing field gets schema default (empty string) since FormDefault throws
    expect(result["failing"]).toBe("")
  })

  it("should handle form with empty fields", async () => {
    const form = new Form(process, "test-form", {
      role,
      form: () => ({}),
    })
    process.start(form)

    const result = await Effect.runPromise(form.resolveDefaults({}, emptyCtx))

    expect(result).toEqual({})
  })

  it("should handle mixed static and closure defaults", async () => {
    // Simulate closure capturing state
    const state = { value: "hello" }

    const form = new Form(process, "test-form", {
      role,
      form: () => ({
        staticField: ES.String.annotations({ [FormDefault]: "static" }),
        dynamicField: ES.String.annotations({
          [FormDefault]: () => state.value.toUpperCase(),
        }),
      }),
    })
    process.start(form)

    const result = await Effect.runPromise(form.resolveDefaults({}, emptyCtx))

    expect(result).toMatchObject({
      staticField: "static",
      dynamicField: "HELLO",
    })
  })

  it("should resolve CurrentProviderUser defaults to the current provider user", async () => {
    const form = new Form(process, "test-form", {
      role,
      form: () => ({
        requestedFor: ProviderUserField({ default: CurrentProviderUser }),
        requestedBy: ProviderUserField({ default: () => CurrentProviderUser }),
      }),
    })
    process.start(form)

    const result = await Effect.runPromise(
      form.resolveDefaults({}, emptyCtx, undefined, "manager@example.com"),
    )

    expect(result).toMatchObject({
      requestedFor: "manager@example.com",
      requestedBy: "manager@example.com",
    })
  })

  it("should not return CurrentProviderUser symbols when no provider user is available", async () => {
    const form = new Form(process, "test-form", {
      role,
      form: () => ({
        requestedFor: ProviderUserField({ default: CurrentProviderUser }),
      }),
    })
    process.start(form)

    const result = await Effect.runPromise(form.resolveDefaults({}, emptyCtx))

    expect(result).toMatchObject({ requestedFor: "" })
    expect(result["requestedFor"]).not.toBe(CurrentProviderUser)
  })
})
