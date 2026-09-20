import { DateTime, Schema as ES, Effect, Layer } from "effect"
import {
  type ClientFormDefinition,
  FormComponentType,
} from "@pf/form-client-representation"
import {
  BooleanField,
  DynamicTextBlock,
  ListField,
  RadioField,
  TableField,
  TextBlock,
  TextField,
  Wrapper,
} from "@pf/form-schema"
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

// These tests use dynamic text resolvers without service dependencies. The
// renderable API still exposes an unknown environment for service-backed forms.
// This empty layer cast is only valid for no-service dynamic text resolvers.
const noServiceDynamicTextLayer = Layer.empty as Layer.Layer<unknown>

interface RenderableFormForTest {
  readonly renderableClientFormDefinition: () => Effect.Effect<
    ClientFormDefinition,
    unknown,
    unknown
  >
}

interface StatefulRenderableFormForTest<
  TSteps extends Record<string, StepMeta>,
> {
  readonly renderableClientFormDefinitionWithState: (
    state: Record<string, unknown>,
    ctx: FlowContext<TSteps>,
    item?: unknown,
  ) => Effect.Effect<ClientFormDefinition, unknown, unknown>
}

const runNoServiceRenderableDefinition = (
  effect: Effect.Effect<ClientFormDefinition, unknown, unknown>,
) => Effect.runPromise(effect.pipe(Effect.provide(noServiceDynamicTextLayer)))

const renderFormDefinition = (form: RenderableFormForTest) =>
  runNoServiceRenderableDefinition(form.renderableClientFormDefinition())

const renderFormComponents = async (form: RenderableFormForTest) =>
  (await renderFormDefinition(form)).components

const renderFormComponentsWithState = async <
  TSteps extends Record<string, StepMeta>,
>(
  form: StatefulRenderableFormForTest<TSteps>,
  state: Record<string, unknown>,
  ctx: FlowContext<TSteps>,
) =>
  (
    await runNoServiceRenderableDefinition(
      form.renderableClientFormDefinitionWithState(state, ctx),
    )
  ).components

describe("Form", () => {
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
              expiresAt: () => DateTime.unsafeMake("2026-04-30T10:00:00Z"),
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
          expiresAt: () => DateTime.unsafeMake("2026-04-30T10:00:00Z"),
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

    it("should append typed rules in call order and serialize them", async () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })

      const form = new Form(process, "submit", {
        role: mockRole,
        form: () => ({
          status: TextField({ label: "Status" }),
          details: TextField({ label: "Details" }),
          section: Wrapper({
            notes: TextField({ label: "Notes" }),
          }),
        }),
      })

      const returned = form
        .rules((value, rule) => [
          rule.when(value.status.equals("hidden")).effects({
            details: { hidden: true },
          }),
        ])
        .rules((value, rule) => [
          rule.when(value.status.notEquals("editable")).effects({
            section: {
              [Form.self]: { hidden: false },
              notes: { disabled: true, required: true },
            },
          }),
          rule.when(value.notes.present()).effects({
            section: { notes: { hidden: false } },
          }),
        ])

      expect(returned).toBe(form)
      const definition = await Effect.runPromise(form.clientFormDefinition())
      expect(definition.components).toEqual(
        expect.objectContaining({
          status: expect.objectContaining({ _tag: FormComponentType.Text }),
          details: expect.objectContaining({ _tag: FormComponentType.Text }),
          section: expect.objectContaining({
            _tag: FormComponentType.FieldSet,
          }),
        }),
      )
      expect(
        Object.values(definition.components).every(
          (component) => typeof component._tag === "string",
        ),
      ).toBe(true)
      expect(definition.rules).toHaveLength(3)
      expect((await renderFormDefinition(form)).rules).toEqual([
        {
          condition: {
            _tag: "equals",
            left: { _tag: "field", path: ["status"] },
            right: { _tag: "literal", value: "hidden" },
          },
          effects: [{ target: ["details"], state: { hidden: true } }],
        },
        {
          condition: {
            _tag: "notEquals",
            left: { _tag: "field", path: ["status"] },
            right: { _tag: "literal", value: "editable" },
          },
          effects: [
            { target: ["section"], state: { hidden: false } },
            {
              target: ["section", "notes"],
              state: { disabled: true, required: true },
            },
          ],
        },
        {
          condition: {
            _tag: "present",
            value: { _tag: "field", path: ["notes"] },
          },
          effects: [{ target: ["section", "notes"], state: { hidden: false } }],
        },
      ])
    })

    it("should build rule-free and state-aware client form definitions", async () => {
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

      const ordinary = await Effect.runPromise(form.clientFormDefinition())
      const stateAware = await Effect.runPromise(
        form.clientFormDefinitionWithState({ detailed: true }, emptyCtx),
      )
      const renderable = await Effect.runPromise(
        form
          .renderableClientFormDefinitionWithState({ detailed: true }, emptyCtx)
          .pipe(Effect.provide(noServiceDynamicTextLayer)),
      )

      expect(ordinary.rules).toEqual([])
      expect(ordinary.components).toHaveProperty("summary")
      expect(ordinary.components["details"]).toMatchObject({ content: "" })
      expect(stateAware.rules).toEqual([])
      expect(stateAware.components).toHaveProperty("details")
      expect(renderable).toEqual(stateAware)
    })

    it("should distinguish target state keys from fields with the same names", async () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })

      const form = new Form(process, "submit", {
        role: mockRole,
        form: () => ({
          status: TextField({ label: "Status" }),
          hidden: TextField({ label: "Hidden named field" }),
        }),
      }).rules((value, rule) => [
        rule.when(value.status.present()).effects({
          hidden: { hidden: true },
        }),
      ])

      expect((await renderFormDefinition(form)).rules).toEqual([
        {
          condition: {
            _tag: "present",
            value: { _tag: "field", path: ["status"] },
          },
          effects: [{ target: ["hidden"], state: { hidden: true } }],
        },
      ])
    })

    it("should serialize label effects in rule targets", async () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })

      const form = new Form(process, "submit", {
        role: mockRole,
        form: () => ({
          type: RadioField({
            label: "Type",
            options: [
              { value: "a", label: "A" },
              { value: "b", label: "B" },
            ],
          }),
          field: TextField({ label: "Field" }),
        }),
      }).rules((value, rule) => [
        rule
          .when(value.type.equals("a"))
          .effects(
            { field: { label: "Label A" } },
            { field: { label: "Label B" } },
          ),
      ])

      expect((await renderFormDefinition(form)).rules).toEqual([
        {
          condition: {
            _tag: "equals",
            left: { _tag: "field", path: ["type"] },
            right: { _tag: "literal", value: "a" },
          },
          effects: [{ target: ["field"], state: { label: "Label A" } }],
          otherwise: [{ target: ["field"], state: { label: "Label B" } }],
        },
      ])
    })

    it("should type-check rule value accessors and target trees", () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })

      const typeFixtures = () => {
        new Form(process, "submit", {
          role: mockRole,
          form: () => ({
            name: ES.String,
            age: ES.Number,
            approved: ES.Boolean,
            section: Wrapper({
              notes: ES.String,
            }),
          }),
        }).rules((value, rule) => {
          type EffectTree = Parameters<
            ReturnType<typeof rule.when>["effects"]
          >[0]

          // @ts-expect-error misspelled value accessor name
          value.nmae
          // @ts-expect-error invalid comparison value for number field
          value.age.equals("old")
          // @ts-expect-error boolean fields do not support ordering comparisons
          value.approved.gt(true)
          value.notes.present()
          // @ts-expect-error invalid target name
          const missingTarget: EffectTree = { missing: { hidden: true } }
          const invalidContainerEffect: EffectTree = {
            section: {
              // @ts-expect-error container self-effects cannot be authored as child names
              hidden: true,
            },
          }

          void missingTarget
          void invalidContainerEffect

          return [
            rule
              .when(value.name.equals("Ada"))
              .effects({ name: { hidden: true } }),
          ]
        })
      }

      expect(typeof typeFixtures).toBe("function")
    })

    it("should serialize structural and static display rule targets", async () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })

      const form = new Form(process, "submit", {
        role: mockRole,
        form: () => ({
          status: TextField({ label: "Status" }),
          section: Wrapper({
            help: TextBlock("Helpful copy"),
            notes: TextField({ label: "Notes" }),
          }),
        }),
      }).rules((value, rule) => [
        rule.when(value.status.equals("hide")).effects({
          section: {
            [Form.self]: { hidden: true },
            help: { hidden: true, disabled: true },
          },
        }),
      ])

      expect((await renderFormDefinition(form)).rules).toEqual([
        {
          condition: {
            _tag: "equals",
            left: { _tag: "field", path: ["status"] },
            right: { _tag: "literal", value: "hide" },
          },
          effects: [
            { target: ["section"], state: { hidden: true } },
            {
              target: ["section", "help"],
              state: { hidden: true, disabled: true },
            },
          ],
        },
      ])
    })

    it("should serialize rule targets through list and table item children", async () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })

      const form = new Form(process, "submit", {
        role: mockRole,
        form: () => ({
          status: TextField({ label: "Status" }),
          items: ListField({
            child: TextField({ label: "Child" }),
          }),
          rows: TableField({
            summary: TextField({ label: "Summary" }),
          }),
        }),
      }).rules((value, rule) => [
        rule.when(value.status.equals("hide")).effects({
          // Runtime validation must traverse itemChildren for JS callers that
          // author item-child targets outside the typed rule tree.
          items: { child: { hidden: true } },
          rows: { summary: { hidden: true } },
        } as never),
      ])

      expect((await renderFormDefinition(form)).rules).toEqual([
        {
          condition: {
            _tag: "equals",
            left: { _tag: "field", path: ["status"] },
            right: { _tag: "literal", value: "hide" },
          },
          effects: [
            { target: ["items", "child"], state: { hidden: true } },
            { target: ["rows", "summary"], state: { hidden: true } },
          ],
        },
      ])
    })

    it("should reject required effects on structural and static display targets", async () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })

      const structuralForm = new Form(process, "structural", {
        role: mockRole,
        form: () => ({
          status: TextField({ label: "Status" }),
          section: Wrapper({
            notes: TextField({ label: "Notes" }),
          }),
        }),
      }).rules((value, rule) => [
        rule.when(value.status.present()).effects({
          // Runtime validation protects JS callers that bypass the typed tree.
          section: { [Form.self]: { required: true } as never },
        }),
      ])

      await expect(
        Effect.runPromise(structuralForm.clientFormDefinition()),
      ).rejects.toThrow(
        'Form "structural" rule target "section" cannot set required on structural or static display components',
      )

      const staticForm = new Form(process, "static", {
        role: mockRole,
        form: () => ({
          status: TextField({ label: "Status" }),
          help: TextBlock("Helpful copy"),
        }),
      }).rules((value, rule) => [
        rule.when(value.status.present()).effects({
          // @ts-expect-error static display targets cannot be required
          help: { required: true },
        }),
      ])

      await expect(
        Effect.runPromise(staticForm.clientFormDefinition()),
      ).rejects.toThrow(
        'Form "static" rule target "help" cannot set required on structural or static display components',
      )

      const tableForm = new Form(process, "table", {
        role: mockRole,
        form: () => ({
          status: TextField({ label: "Status" }),
          rows: TableField({ label: ES.String }),
        }),
      }).rules((value, rule) => [
        rule.when(value.status.present()).effects({
          // @ts-expect-error table display targets cannot be required
          rows: { required: true },
        }),
      ])

      await expect(
        Effect.runPromise(tableForm.clientFormDefinition()),
      ).rejects.toThrow(
        'Form "table" rule target "rows" cannot set required on structural or static display components',
      )

      const otherwiseForm = new Form(process, "otherwise", {
        role: mockRole,
        form: () => ({
          status: TextField({ label: "Status" }),
          help: TextBlock("Helpful copy"),
        }),
      }).rules((value, rule) => [
        rule.when(value.status.present()).effects(
          { status: { disabled: true } },
          {
            // @ts-expect-error static display targets cannot be required
            help: { required: true },
          },
        ),
      ])

      await expect(
        Effect.runPromise(otherwiseForm.clientFormDefinition()),
      ).rejects.toThrow(
        'Form "otherwise" rule target "help" cannot set required on structural or static display components',
      )
    })

    it("should validate nested non-flattened rule condition paths", async () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })

      const form = new Form(process, "submit", {
        role: mockRole,
        form: () => ({
          status: TextField({ label: "Status" }),
          section: ES.Struct({
            notes: TextField({ label: "Notes" }),
          }),
        }),
      }).rules((value, rule) => [
        rule.when(value.section.notes.present()).effects({
          status: { hidden: true },
        }),
      ])

      expect((await renderFormDefinition(form)).rules).toEqual([
        {
          condition: {
            _tag: "present",
            value: { _tag: "field", path: ["section", "notes"] },
          },
          effects: [{ target: ["status"], state: { hidden: true } }],
        },
      ])
    })

    it("should preserve a structural rule target when runtime content uses its fallback", async () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })
      const form = new Form(process, "submit", {
        role: mockRole,
        form: ({ content }) => ({
          status: TextField({ label: "Status" }),
          details: content((state: { readonly includeDetails?: boolean }) =>
            state.includeDetails !== false ? TextBlock("Details") : undefined,
          ),
        }),
      }).rules((value, rule) => [
        rule
          .when(value.status.equals("hidden"))
          .effects({ details: { hidden: true } }),
      ])
      const definition = await Effect.runPromise(
        form.clientFormDefinitionWithState({ includeDetails: false }, emptyCtx),
      )
      expect(definition.components["details"]).toMatchObject({ content: "" })
      expect(definition.rules).toMatchObject([
        { effects: [{ target: ["details"], state: { hidden: true } }] },
      ])
    })

    it("should resolve dynamic text blocks inside wrappers", async () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })

      const form = new Form(process, "submit", {
        role: mockRole,
        form: () => ({
          section: Wrapper({
            status: DynamicTextBlock({
              text: "Checking status...",
              resolve: () => Effect.succeed("Status available."),
            }),
          }),
        }),
      })

      const representation = await renderFormComponents(form)
      const section = representation["section"]

      expect(section?._tag).toBe(FormComponentType.FieldSet)
      if (section?._tag !== FormComponentType.FieldSet) {
        throw new Error("Expected section to be a fieldset")
      }

      const status = section.children["status"]
      expect(status?._tag).toBe(FormComponentType.Static)
      if (status?._tag !== FormComponentType.Static) {
        throw new Error("Expected status to be static text")
      }
      expect(status.content).toBe("Status available.")
    })

    it("should keep dynamic text fallback when resolution fails", async () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })

      const form = new Form(process, "submit", {
        role: mockRole,
        form: () => ({
          status: DynamicTextBlock({
            text: "Checking status...",
            resolve: () => Effect.fail("status lookup failed"),
          }),
        }),
      })

      const representation = await renderFormComponents(form)
      const status = representation["status"]

      expect(status?._tag).toBe(FormComponentType.Static)
      if (status?._tag !== FormComponentType.Static) {
        throw new Error("Expected status to be static text")
      }
      expect(status.content).toBe("Checking status...")
    })

    it("should resolve dynamic text blocks inside list items", async () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })

      const form = new Form(process, "submit", {
        role: mockRole,
        form: () => ({
          items: ES.Array(
            ES.Struct({
              status: DynamicTextBlock({
                text: "Checking item status...",
                resolve: () => Effect.succeed("Item status available."),
              }),
            }),
          ),
        }),
      })

      const representation = await renderFormComponents(form)
      const items = representation["items"]

      expect(items?._tag).toBe(FormComponentType.List)
      if (items?._tag !== FormComponentType.List) {
        throw new Error("Expected items to be a list")
      }

      const status = items.itemChildren["status"]
      expect(status?._tag).toBe(FormComponentType.Static)
      if (status?._tag !== FormComponentType.Static) {
        throw new Error("Expected status to be static text")
      }
      expect(status.content).toBe("Item status available.")
    })

    it("should resolve dynamic text blocks inside wrappers in list items", async () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })

      const form = new Form(process, "submit", {
        role: mockRole,
        form: () => ({
          items: ES.Array(
            ES.Struct({
              section: Wrapper({
                status: DynamicTextBlock({
                  text: "Checking wrapped item status...",
                  resolve: () =>
                    Effect.succeed("Wrapped item status available."),
                }),
              }),
            }),
          ),
        }),
      })

      const representation = await renderFormComponents(form)
      const items = representation["items"]

      expect(items?._tag).toBe(FormComponentType.List)
      if (items?._tag !== FormComponentType.List) {
        throw new Error("Expected items to be a list")
      }

      const section = items.itemChildren["section"]
      expect(section?._tag).toBe(FormComponentType.FieldSet)
      if (section?._tag !== FormComponentType.FieldSet) {
        throw new Error("Expected section to be a fieldset")
      }

      const status = section.children["status"]
      expect(status?._tag).toBe(FormComponentType.Static)
      if (status?._tag !== FormComponentType.Static) {
        throw new Error("Expected status to be static text")
      }
      expect(status.content).toBe("Wrapped item status available.")
    })

    it("should resolve dynamic text blocks inside table items", async () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })

      const form = new Form(process, "submit", {
        role: mockRole,
        form: () => ({
          history: TableField({
            status: DynamicTextBlock({
              text: "Checking history status...",
              resolve: () => Effect.succeed("History status available."),
            }),
          }),
        }),
      })

      const representation = await renderFormComponents(form)
      const history = representation["history"]

      expect(history?._tag).toBe(FormComponentType.Table)
      if (history?._tag !== FormComponentType.Table) {
        throw new Error("Expected history to be a table")
      }

      const status = history.itemChildren["status"]
      expect(status?._tag).toBe(FormComponentType.Static)
      if (status?._tag !== FormComponentType.Static) {
        throw new Error("Expected status to be static text")
      }
      expect(status.content).toBe("History status available.")
    })

    it("should resolve dynamic text blocks inside nested wrappers", async () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })

      const form = new Form(process, "submit", {
        role: mockRole,
        form: () => ({
          outer: Wrapper({
            inner: Wrapper({
              status: DynamicTextBlock({
                text: "Checking nested status...",
                resolve: () => Effect.succeed("Nested status available."),
              }),
            }),
          }),
        }),
      })

      const representation = await renderFormComponents(form)
      const outer = representation["outer"]

      expect(outer?._tag).toBe(FormComponentType.FieldSet)
      if (outer?._tag !== FormComponentType.FieldSet) {
        throw new Error("Expected outer to be a fieldset")
      }

      const inner = outer.children["inner"]
      expect(inner?._tag).toBe(FormComponentType.FieldSet)
      if (inner?._tag !== FormComponentType.FieldSet) {
        throw new Error("Expected inner to be a fieldset")
      }

      const status = inner.children["status"]
      expect(status?._tag).toBe(FormComponentType.Static)
      if (status?._tag !== FormComponentType.Static) {
        throw new Error("Expected status to be static text")
      }
      expect(status.content).toBe("Nested status available.")
    })

    it("should resolve dynamic text blocks with state", async () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })
      const submitForm = new Form(process, "submit", {
        role: mockRole,
        form: () => ({ name: TextField({ label: "Name" }) }),
      })
      const flow = process.start(submitForm)

      const reviewForm = new Form(flow, "review", {
        role: mockRole,
        form: ({ content }) => ({
          status: content(
            (state) =>
              DynamicTextBlock({
                text: "Checking status...",
                resolve: () =>
                  Effect.succeed(`Status available for ${state.name}.`),
              }),
            TextBlock("Checking status..."),
          ),
        }),
      })

      const representation = await renderFormComponentsWithState(
        reviewForm,
        { name: "Ada" },
        submitFlowCtx,
      )
      const status = representation["status"]

      expect(status?._tag).toBe(FormComponentType.Static)
      if (status?._tag !== FormComponentType.Static) {
        throw new Error("Expected status to be static text")
      }
      expect(status.content).toBe("Status available for Ada.")
    })
  })

  describe("form function with state", () => {
    it("should create a form with form function accessing state", () => {
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

      // Define annotation symbols (same as form-schema uses)
      const FormDefault = Symbol.for("pf/form/annotation/Default")
      const FormReadOnly = Symbol.for("pf/form/annotation/ReadOnly")

      const flow = process.start(submitForm)
      const approveForm = new Form(flow, "approve", {
        role: mockRole,
        form: ({ value }) => ({
          requestedDates: ES.String.annotations({
            [FormReadOnly]: true,
            [FormDefault]: value((state) => state.dates),
          }),
          approved: ES.Boolean,
        }),
      })

      expect(approveForm.output).toBeDefined()
    })

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
          requestedDates: ES.String.annotations({
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
          summary: ES.String.annotations({
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
      const summarySchema = fields?.["summary"] as ES.Schema.Any
      const defaultSymbol = Symbol.for("pf/form/annotation/Default")
      expect(summarySchema.ast.annotations[defaultSymbol]).toBe(
        "John Doe <john@example.com>",
      )
    })

    it("should work with Process scope (no inherited state)", () => {
      const process = new Process(orgUnit, "process", {
        name: "Test",
        purpose: "Test",
      })

      // new Form with Process scope has no inherited state
      const submitForm = new Form(process, "submit", {
        role: mockRole,
        form: () => ({
          item: ES.String,
          value: ES.Number,
        }),
      })

      expect(submitForm.output).toBeDefined()
      expect(submitForm.output["item"]).toBeDefined()
      expect(submitForm.output["value"]).toBeDefined()
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
        form.outputSchema as ES.Schema<{ name: string; age: number }>,
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
      const schema = form.outputSchema as ES.Schema<{
        min: number
        max: number
      }>

      // Valid data passes
      const valid = await Effect.runPromise(
        ES.decodeUnknown(schema)({ min: 1, max: 10 }),
      )
      expect(valid).toEqual({ min: 1, max: 10 })

      // Invalid cross-field data fails
      const result = await Effect.runPromiseExit(
        ES.decodeUnknown(schema)({ min: 10, max: 1 }),
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
        schema as ES.Schema<{
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
        schema as ES.Schema<{ approved: boolean }>,
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

      const schema = form.submissionEffectSchema as ES.Schema<{
        min: number
        max: number
      }>

      // Valid flat data passes
      const valid = await Effect.runPromise(
        ES.decodeUnknown(schema)({ min: 1, max: 10 }),
      )
      expect(valid).toEqual({ min: 1, max: 10 })

      // Invalid cross-field data fails
      const result = await Effect.runPromiseExit(
        ES.decodeUnknown(schema)({ min: 10, max: 1 }),
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
