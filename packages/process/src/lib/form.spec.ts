import { DateTime, Duration, Schema as ES, Effect } from "effect"
import { BooleanField, TextBlock, TextField, Wrapper } from "@pf/form-schema"
import type { FlowContext, StepMeta, SummaryContext } from "./flow-context"
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
    startedAt: DateTime.nowUnsafe(),
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
      completedAt: DateTime.nowUnsafe(),
    },
  },
  step: {},
}

const summaryCtx: SummaryContext<Record<string, never>> = {
  ...emptyCtx,
  providerUserDisplay: {
    display: (providerUserIdOrEmail) =>
      Effect.succeed(
        providerUserIdOrEmail === "pvu-1"
          ? "Ada Lovelace"
          : providerUserIdOrEmail,
      ),
  },
}

const submitSummaryCtx: SummaryContext<{ submit: StepMeta }> = {
  ...summaryCtx,
  step: {
    submit: summaryCtx.process.startStep,
  },
}

const submitFlowCtx: FlowContext<{ submit: StepMeta }> = {
  ...emptyCtx,
  step: {
    submit: emptyCtx.process.startStep,
  },
}

describe("Form", () => {
  it("validates named deadlines and propagates human handler state through nested paths", () => {
    const org = new Organisation({ name: "Deadlines" })
    const role = new Role(org, "manager", { name: "Manager" })
    const process = new Process(org, "approval", {
      name: "Approval",
      purpose: "Staged approval",
    })
    const start = new Form(process, "start", {
      role,
      form: ES.Struct({ subject: ES.String }),
    })
    const started = process.start(start)
    const owner = new Form(started, "owner", {
      role,
      form: ES.Struct({ approved: ES.Boolean }),
    })
    started.next(owner).end()
    const manager = new Form(started, "manager", {
      role,
      form: ES.Struct({ group: Wrapper({ decision: ES.String }) }),
    })
    const escalated = owner.onDeadline("escalation", {
      interrupting: true,
      after: Duration.seconds(60),
      handler: manager,
    })
    const done = new Form(escalated, "done", {
      role,
      form: ES.Struct({}),
      summary: (state) => {
        const decision: string = state.decision
        // @ts-expect-error The owner has not completed on this path.
        state.approved
        // @ts-expect-error Form wrapper keys do not enter process state.
        state.group
        return Effect.succeed({ Decision: decision })
      },
    })
    escalated.next(done).end()
    expect(() =>
      owner.onDeadline("escalation", {
        after: Duration.seconds(90),
        handler: done,
      }),
    ).toThrow("Duplicate deadline")
    expect(() =>
      owner.onDeadline(" ", { after: Duration.seconds(90), handler: done }),
    ).toThrow("must not be empty")
    const followUp = new Form(started, "follow-up", {
      role,
      form: ES.Struct({}),
    })
    manager.onDeadline("escalation", {
      after: Duration.seconds(30),
      handler: followUp,
    })
    expect(process.validateFlows().dangling).toContain(followUp.node.path)
    process.addEndEdge(followUp)
    expect(process.validateFlows()).toEqual({
      unreachable: [],
      dangling: [],
      missingElse: [],
      multipleElse: [],
      orphanElse: [],
    })
  })

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

  describe("static form", () => {
    it("should create a form with static form function", () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })

      const form = new Form(process, "submit", {
        role: mockRole,
        form: () => ({
          name: ES.String,
          age: ES.Number,
        }),
      })

      expect(form.output).toBeDefined()
      expect(form.output["name"]).toBeDefined()
      expect(form.output["age"]).toBeDefined()
    })

    it("should reject publicCompletion on start forms", () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })

      expect(
        () =>
          new Form(process, "submit", {
            role: mockRole,
            form: () => ({}),
            publicCompletion: {
              recipient: () => "external@example.com",
              expiresAt: () => DateTime.makeUnsafe("2026-04-30T10:00:00Z"),
            },
          }),
      ).toThrow("publicCompletion is only valid on non-start forms")
    })

    it("should allow publicCompletion on non-start forms", () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })
      const submit = new Form(process, "submit", {
        role: mockRole,
        form: () => ({}),
      })
      const flow = process.start(submit)

      const approve = new Form(flow, "approve", {
        role: mockRole,
        form: () => ({}),
        publicCompletion: {
          recipient: () => "external@example.com",
          expiresAt: () => DateTime.makeUnsafe("2026-04-30T10:00:00Z"),
        },
      })

      expect(approve.publicCompletion).toBeDefined()
    })

    it("should work in a process flow", () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })

      const submitForm = new Form(process, "submit", {
        role: mockRole,
        form: () => ({
          dates: ES.String,
        }),
      })

      const approveForm = new Form(process, "approve", {
        role: mockRole,
        form: () => ({
          approved: ES.Boolean,
        }),
      })

      process.start(submitForm).next(approveForm)

      // Verify forms are added to process
      expect(submitForm.process).toBe(process)
      expect(approveForm.process).toBe(process)
    })

    it("resolves optional content independently for each request", () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })
      const form = new Form(process, "submit", {
        role: mockRole,
        form: ({ content }) => ({
          summary: TextField({ label: "Summary" }),
          details: content((state: { readonly detailed?: boolean }) =>
            state.detailed ? TextBlock("Details") : undefined,
          ),
        }),
      })

      expect(form.resolvePresentation({}, emptyCtx)).toMatchObject({
        summary: { label: "Summary" },
        details: { text: "" },
      })
      expect(
        form.resolvePresentation({ detailed: true }, emptyCtx)["details"],
      ).toEqual({ text: "Details" })
      expect(form.resolvePresentation({}, emptyCtx)["details"]).toEqual({
        text: "",
      })
    })
  })

  describe("form function with state", () => {
    it("should defer state access until getFieldsWithState", () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })

      const submitForm = new Form(process, "submit", {
        role: mockRole,
        form: () => ({
          dates: ES.String,
        }),
      })

      // Track the state passed to form function
      let formFnState: unknown = null

      // Define annotation symbols (same as form-schema uses)
      const FormDefault = Symbol.for("pf/form/annotation/Default")
      const FormReadOnly = Symbol.for("pf/form/annotation/ReadOnly")

      const flow = process.start(submitForm)
      const approveForm = new Form(flow, "approve", {
        role: mockRole,
        form: ({ value }) => ({
          requestedDates: ES.String.annotate({
            [FormReadOnly]: true,
            [FormDefault]: value((state) => {
              formFnState = state
              return state.dates
            }),
          }),
          approved: ES.Boolean,
        }),
      })

      // Construction must not resolve defaults against fictitious state.
      expect(formFnState).toBeNull()

      // Re-execute with real state (context not used by this form function)
      const realState = { dates: "2024-01-15" } as const
      const fieldsWithState = approveForm.getFieldsWithState(
        realState as typeof realState & Record<string, never>,
        emptyCtx as never,
      )

      expect(fieldsWithState).toBeDefined()
      expect(formFnState).toEqual(realState)
    })
  })

  describe("Form with flow scope", () => {
    it("should infer state type from multiple previous steps", () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })

      const step1 = new Form(process, "step1", {
        role: mockRole,
        form: () => ({
          firstName: ES.String,
          lastName: ES.String,
        }),
      })

      const step2 = new Form(process, "step2", {
        role: mockRole,
        form: () => ({
          email: ES.String,
        }),
      })

      const flow = process.start(step1).next(step2)

      // Define annotation symbol (same as form-schema uses)
      const FormDefault = Symbol.for("pf/form/annotation/Default")

      // new Form with flow scope infers accumulated state { firstName, lastName, email }
      const approveForm = new Form(flow, "approve", {
        role: mockRole,
        form: ({ value }) => ({
          summary: ES.String.annotate({
            // Type-safe access to all accumulated state
            [FormDefault]: value(
              (state) =>
                `${state.firstName} ${state.lastName} <${state.email}>`,
            ),
          }),
          approved: ES.Boolean,
        }),
      })

      // Verify the form function works with real state
      const realState = {
        firstName: "John",
        lastName: "Doe",
        email: "john@example.com",
      }

      // Context not used by this form function
      const fields = approveForm.getFieldsWithState(
        realState,
        emptyCtx as never,
      )
      expect(fields).toBeDefined()

      // The lazy default has been resolved to its encoded value.
      const summarySchema = fields?.["summary"] as ES.Top
      const defaultSymbol = Symbol.for("pf/form/annotation/Default")
      expect(
        Reflect.get(summarySchema.ast.annotations ?? {}, defaultSymbol),
      ).toBe("John Doe <john@example.com>")
    })
  })

  describe("summary", () => {
    it("continues to support synchronous summary callbacks", async () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })

      const submit = new Form(process, "submit", {
        role: mockRole,
        form: () => ({ requestedFor: ES.String }),
      })

      const form = new Form(process.start(submit), "review", {
        role: mockRole,
        form: () => ({}),
        summary: (state) => ({ "Requested for": state.requestedFor }),
      })

      const summary = await Effect.runPromise(
        form.getSummary({ requestedFor: "pvu-1" }, submitSummaryCtx),
      )

      expect(summary).toEqual({ "Requested for": "pvu-1" })
    })

    it("can resolve provider-user display values from summary context", async () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })

      const submit = new Form(process, "submit", {
        role: mockRole,
        form: () => ({ requestedFor: ES.String }),
      })

      const form = new Form(process.start(submit), "review", {
        role: mockRole,
        form: () => ({}),
        summary: (state, ctx) =>
          Effect.gen(function* () {
            return {
              "Requested for": yield* ctx.providerUserDisplay.display(
                state.requestedFor,
              ),
            }
          }),
      })

      const summary = await Effect.runPromise(
        form.getSummary({ requestedFor: "pvu-1" }, submitSummaryCtx),
      )

      expect(summary).toEqual({ "Requested for": "Ada Lovelace" })
    })

    it("falls back to an empty summary when a summary callback throws", async () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })

      const submit = new Form(process, "submit", {
        role: mockRole,
        form: () => ({ requestedFor: ES.String }),
      })

      const form = new Form(process.start(submit), "review", {
        role: mockRole,
        form: () => ({}),
        summary: () => {
          throw new Error("summary failed")
        },
      })

      const summary = await Effect.runPromise(
        form.getSummary({ requestedFor: "pvu-1" }, submitSummaryCtx),
      )

      expect(summary).toEqual({})
    })

    it("falls back to an empty summary when an async summary has a defect", async () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })

      const submit = new Form(process, "submit", {
        role: mockRole,
        form: () => ({ requestedFor: ES.String }),
      })

      const form = new Form(process.start(submit), "review", {
        role: mockRole,
        form: () => ({}),
        summary: () => Effect.die("summary defect"),
      })

      const summary = await Effect.runPromise(
        form.getSummary({ requestedFor: "pvu-1" }, submitSummaryCtx),
      )

      expect(summary).toEqual({})
    })
  })

  describe("getAssignee", () => {
    it("resolves a synchronous assignee", async () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })

      const submit = new Form(process, "submit", {
        role: mockRole,
        form: () => ({ requestedFor: ES.String }),
      })

      const form = new Form(process.start(submit), "review", {
        role: mockRole,
        form: () => ({}),
        assignee: (state) => state.requestedFor,
      })

      // No service-backed assignees in these cases; R is deferred as unknown.
      const assignee = await Effect.runPromise(
        form.getAssignee(
          { requestedFor: "pvu-1" },
          submitFlowCtx,
        ) as Effect.Effect<string | undefined, never, never>,
      )

      expect(assignee).toBe("pvu-1")
    })

    it("falls back to undefined when an assignee callback throws", async () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })

      const submit = new Form(process, "submit", {
        role: mockRole,
        form: () => ({ requestedFor: ES.String }),
      })

      const form = new Form(process.start(submit), "review", {
        role: mockRole,
        form: () => ({}),
        assignee: () => {
          throw new Error("assignee failed")
        },
      })

      const assignee = await Effect.runPromise(
        form.getAssignee(
          { requestedFor: "pvu-1" },
          submitFlowCtx,
        ) as Effect.Effect<string | undefined, never, never>,
      )

      expect(assignee).toBeUndefined()
    })

    it("falls back to undefined when an async assignee has a defect", async () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })

      const submit = new Form(process, "submit", {
        role: mockRole,
        form: () => ({ requestedFor: ES.String }),
      })

      const form = new Form(process.start(submit), "review", {
        role: mockRole,
        form: () => ({}),
        assignee: () => Effect.die("assignee defect"),
      })

      const assignee = await Effect.runPromise(
        form.getAssignee(
          { requestedFor: "pvu-1" },
          submitFlowCtx,
        ) as Effect.Effect<string | undefined, never, never>,
      )

      expect(assignee).toBeUndefined()
    })
  })

  describe("validate (struct-level)", () => {
    it("should expose schema without refinement when no validate is provided", () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })

      const form = new Form(process, "submit", {
        role: mockRole,
        form: () => ({
          name: ES.String,
          age: ES.Number,
        }),
      })

      expect(form.outputSchema).toBeDefined()
      // Schema decodes valid data
      const decoded = ES.decodeUnknownSync(
        form.outputSchema as ES.Codec<{ name: string; age: number }>,
      )({
        name: "Alice",
        age: 30,
      })
      expect(decoded).toEqual({ name: "Alice", age: 30 })
    })

    it("should reject invalid cross-field combinations via validate", async () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })

      const form = new Form(process, "submit", {
        role: mockRole,
        form: () => ({
          min: ES.Number,
          max: ES.Number,
        }),
        validate: (input) =>
          Effect.succeed(
            input.min > input.max ? "min must not exceed max" : undefined,
          ),
      })

      expect(form.outputSchema).toBeDefined()
      const schema = form.outputSchema as ES.Codec<{
        min: number
        max: number
      }>

      // Valid data passes
      const valid = await Effect.runPromise(
        ES.decodeUnknownEffect(schema)({ min: 1, max: 10 }),
      )
      expect(valid).toEqual({ min: 1, max: 10 })

      // Invalid cross-field data fails
      const result = await Effect.runPromiseExit(
        ES.decodeUnknownEffect(schema)({ min: 10, max: 1 }),
      )
      expect(result._tag).toBe("Failure")
    })
  })

  describe("submissionEffectSchema", () => {
    it("should flatten wrapper fields in submission schema", () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })

      const form = new Form(process, "submit", {
        role: mockRole,
        form: () => ({
          contactDetails: Wrapper({
            firstName: ES.String,
            lastName: ES.String,
          }),
          email: ES.String,
        }),
      })

      const schema = form.submissionEffectSchema
      expect(schema).toBeDefined()

      // Flat input should decode successfully
      const decoded = ES.decodeUnknownSync(
        schema as ES.Codec<{
          firstName: string
          lastName: string
          email: string
        }>,
      )({
        firstName: "Alice",
        lastName: "Smith",
        email: "alice@example.com",
      })

      expect(decoded).toEqual({
        firstName: "Alice",
        lastName: "Smith",
        email: "alice@example.com",
      })
    })

    it("should exclude read-only fields from submission schema", () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })

      const form = new Form(process, "submit", {
        role: mockRole,
        form: () => ({
          displayName: TextField({ label: "Name", readOnly: true }),
          approved: ES.Boolean,
        }),
      })

      const schema = form.submissionEffectSchema
      // Only editable field should be in the schema
      const decoded = ES.decodeUnknownSync(
        schema as ES.Codec<{ approved: boolean }>,
      )({ approved: true })
      expect(decoded).toEqual({ approved: true })
    })

    it("should apply validate filterEffect to flat submission schema", async () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })

      const form = new Form(process, "submit", {
        role: mockRole,
        form: () => ({
          contactDetails: Wrapper({
            min: ES.Number,
            max: ES.Number,
          }),
        }),
        validate: (input) =>
          Effect.succeed(
            // validate receives flat shape: input.min, not input.contactDetails.min
            input.min > input.max ? "min must not exceed max" : undefined,
          ),
      })

      const schema = form.submissionEffectSchema as ES.Codec<{
        min: number
        max: number
      }>

      // Valid flat data passes
      const valid = await Effect.runPromise(
        ES.decodeUnknownEffect(schema)({ min: 1, max: 10 }),
      )
      expect(valid).toEqual({ min: 1, max: 10 })

      // Invalid cross-field data fails
      const result = await Effect.runPromiseExit(
        ES.decodeUnknownEffect(schema)({ min: 10, max: 1 }),
      )
      expect(result._tag).toBe("Failure")
    })
  })

  describe("type-level state flattening", () => {
    it("should infer flat state type for form with wrappers", () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })

      const submitForm = new Form(process, "submit", {
        role: mockRole,
        form: () => ({
          section: Wrapper({
            firstName: ES.String,
            lastName: ES.String,
          }),
          email: ES.String,
        }),
      })

      const flow = process.start(submitForm)

      // Downstream form gets state with flat keys (no wrapper nesting)
      const nextForm = new Form(flow, "next", {
        role: mockRole,
        form: ({ value }) => ({
          done: BooleanField({
            default: value((state) => {
              // Type-level check: state should have flat keys
              state.firstName satisfies string
              state.lastName satisfies string
              state.email satisfies string
              // @ts-expect-error - wrapper key should NOT exist in state
              state.section

              return false
            }),
          }),
        }),
      })

      expect(nextForm.output).toBeDefined()
    })

    it("should preserve non-wrapper struct nesting in state type", () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })

      const submitForm = new Form(process, "submit", {
        role: mockRole,
        form: () => ({
          address: ES.Struct({
            street: ES.String,
            city: ES.String,
          }),
        }),
      })

      const flow = process.start(submitForm)

      // Non-wrapper structs should preserve nesting in types.
      // typeof state.X is resolved at the type level — no runtime access.
      const nextForm = new Form(flow, "next", {
        role: mockRole,
        form: ({ value }) => ({
          done: BooleanField({
            default: value((state) => {
              // Positive: address preserves nested struct shape
              null as unknown as typeof state.address satisfies {
                readonly street: string
                readonly city: string
              }
              // @ts-expect-error - street should NOT be a top-level key
              state.street

              return false
            }),
          }),
        }),
      })

      expect(nextForm.output).toBeDefined()
    })
  })

  describe("resolveDefaults (flat)", () => {
    it("should produce flat defaults for forms with wrappers", async () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })

      const form = new Form(process, "submit", {
        role: mockRole,
        form: () => ({
          contactDetails: Wrapper({
            firstName: ES.String,
            lastName: ES.String,
          }),
          email: TextField({
            label: "Email",
            default: () => "john@example.com",
          }),
        }),
      })
      process.start(form)

      const result = await Effect.runPromise(form.resolveDefaults({}, emptyCtx))

      // Defaults should be flat (no contactDetails nesting).
      // Schema defaults for fields inside wrappers are flattened.
      expect(result).toMatchObject({
        firstName: "",
        lastName: "",
        email: "john@example.com",
      })
      // Wrapper key should NOT appear
      expect(result).not.toHaveProperty("contactDetails")
    })
  })
})
