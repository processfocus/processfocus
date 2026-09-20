import { DateTime, Effect, Layer, Schema } from "effect"
import {
  BooleanField,
  CalendarSlotField,
  CurrentProviderUser,
  FormDefault,
  FormDescription,
  FormLabel,
  FormReadOnly,
  type FormValue,
  LinkButton,
  ListField,
  LookupField,
  NumberFieldFrom,
  ProviderUserField,
  TableField,
  TextArea,
  TextBlock,
  TextField,
  Wrapper,
} from "@pf/form-schema"
import { Form, mergeFormDefaults, resolveFormFieldDefaults } from "../index"
import { buildFlowContext } from "./flow-context"
import { FormDecorationError } from "./form-decoration"
import { Organisation } from "./organisation"
import { Process } from "./process"
import { Role } from "./role"
import { describe, expect, it } from "bun:test"

const context = buildFlowContext(
  "execution",
  DateTime.unsafeMake("2026-09-16"),
  [],
)
const initial = { ...context, step: {} }
const completed = { ...context, step: { first: context.process.startStep } }
const emptyServices = Layer.empty as Layer.Layer<unknown>
const setup = () => {
  const org = new Organisation({ name: "Lazy forms" })
  const role = new Role(org, "role", { name: "Role" })
  const process = new Process(org, "process", {
    name: "Process",
    purpose: "Test",
  })
  const first = new Form(process, "first", {
    role,
    form: () => ({ name: TextField(), rows: ListField({ name: TextField() }) }),
  })
  return { org, role, process, flow: process.start(first) }
}

const evidenceTable = (rows: FormValue<readonly { readonly name: string }[]>) =>
  TableField({ name: TextField({ label: "Name" }) }, { default: rows })

describe("constructor lazy Form authoring", () => {
  it("keeps static projection inert and resolves content/defaults with request-local state", async () => {
    const { role, flow } = setup()
    let calls = 0
    const fallback = TextBlock("Open a todo")
    const form = new Form(flow, "next", {
      role,
      form: ({ content, value }) => ({
        link: content((state, ctx) => {
          calls++
          return LinkButton(`mailto:${state.name}`, ctx.process.executionId)
        }, fallback),
        name: TextField({
          default: value((state) => state.name.toUpperCase()),
        }),
        evidence: evidenceTable(value((state) => state.rows)),
        display: TextArea({
          readOnly: true,
          default: value((state) => state.name),
        }),
        confirmed: BooleanField({ required: true }),
      }),
    })
    const schema = form.submissionSchema()
    const staticDefinition = await Effect.runPromise(
      form.clientFormDefinition(),
    )
    expect(calls).toBe(0)
    expect(staticDefinition.components["link"]).toMatchObject({
      _tag: "static",
      field: "link",
      content: "Open a todo",
    })
    expect(schema).not.toHaveProperty("properties.display")
    expect(schema).not.toHaveProperty("properties.evidence")
    const first = { name: "one@example.com", rows: [{ name: "one" }] }
    const second = { name: "two@example.com", rows: [{ name: "two" }] }
    expect(
      await Effect.runPromise(form.resolveDefaults(first, completed)),
    ).toMatchObject({
      name: "ONE@EXAMPLE.COM",
      display: first.name,
      evidence: first.rows,
    })
    expect(
      await Effect.runPromise(form.resolveDefaults(second, completed)),
    ).toMatchObject({
      name: "TWO@EXAMPLE.COM",
      display: second.name,
      evidence: second.rows,
    })
    const definition = await Effect.runPromise(
      form.clientFormDefinitionWithState(first, completed),
    )
    expect(definition.components["link"]).toMatchObject({
      _tag: "link",
      field: "link",
      url: "mailto:one@example.com",
    })
    expect(definition.components["link"]?.label).toBeUndefined()
    expect(form.submissionSchema()).toEqual(schema)
    expect(await Effect.runPromise(form.clientFormDefinition())).toEqual(
      staticDefinition,
    )
  })

  it("preserves wrappers, nested optional transformations, list defaults and shared table helpers", async () => {
    const { role, flow } = setup()
    const form = new Form(flow, "nested", {
      role,
      form: ({ value }) => ({
        wrapper: Wrapper({
          flat: TextField({ default: value((state) => state.name) }),
        }),
        nested: Schema.optional(
          Schema.Struct({
            name: TextField({ default: value((state) => state.name) }),
          }),
        ),
        rows: ListField(
          { name: TextField({ label: value((state) => state.name) }) },
          { default: value((state) => state.rows) },
        ),
        count: Schema.optionalWith(
          NumberFieldFrom(Schema.NumberFromString, {
            default: value((state) => state.name),
          }),
          { default: () => 5 },
        ),
        annotated: Schema.optional(Schema.String).annotations({
          [FormDefault]: value((state) => state.name),
          [FormLabel]: value((state) => state.name),
        }),
        owner: ProviderUserField({ default: value(() => CurrentProviderUser) }),
      }),
    })
    const state = { name: "12", rows: [{ name: "row" }] }
    const fields = form.getFieldsWithState(state, completed)
    expect(
      Schema.decodeUnknownSync(Schema.Struct(fields))({
        wrapper: { flat: "x" },
        rows: [],
        owner: "pu-one",
      }),
    ).toMatchObject({ count: 5 })
    expect(
      Schema.decodeUnknownSync(Schema.Struct(fields))({
        wrapper: { flat: "x" },
        rows: [],
        count: "12",
        owner: "pu-one",
      }),
    ).toMatchObject({ count: 12 })
    expect(
      await Effect.runPromise(form.resolveDefaults(state, completed)),
    ).toMatchObject({
      flat: "12",
      nested: { name: "12" },
      rows: state.rows,
      count: "12",
      annotated: "12",
    })
  })

  it("keeps optional encoded defaults isolated between requests", async () => {
    const { role, flow } = setup()
    const form = new Form(flow, "optional-request-default", {
      role,
      form: ({ value }) => ({
        count: Schema.optionalWith(
          NumberFieldFrom(Schema.NumberFromString, {
            default: value((state) => state.name || undefined),
          }),
          { default: () => 5 },
        ),
      }),
    })
    for (const name of ["12", "7", "", "12"]) {
      const fields = form.getFieldsWithState({ name, rows: [] }, completed)
      const defaults = await Effect.runPromise(resolveFormFieldDefaults(fields))
      expect(defaults).toEqual(name ? { count: name } : {})
      const schema = Schema.Struct(fields)
      expect(Schema.decodeUnknownSync(schema)({})).toEqual({ count: 5 })
      expect(Schema.decodeUnknownSync(schema)(defaults)).toEqual({
        count: name ? Number(name) : 5,
      })
      expect(
        Schema.decodeUnknownSync(schema)(
          mergeFormDefaults(defaults, { count: "9" }),
        ),
      ).toEqual({ count: 9 })
    }
  })

  it("infers optional submitted containers and exposes only editable rule values", async () => {
    const { role, flow } = setup()
    const children = {
      edit: TextField(),
      display: TextField({ readOnly: true }),
      help: TextBlock("Help"),
    }
    const form = new Form(flow, "optional-rules", {
      role,
      form: () => ({
        leaf: Schema.optional(TextField({ readOnly: true })),
        nested: Schema.optional(Schema.Struct(children)),
        list: Schema.optional(ListField(children)),
      }),
    }).rules((value, rule) => {
      type Targets = Parameters<ReturnType<typeof rule.when>["effects"]>[0]
      const invalid: Targets = {
        leaf: {
          // @ts-expect-error read-only fields cannot become required inputs
          required: true,
        },
      }
      void invalid
      // @ts-expect-error optional read-only leaves are not rule values
      value.leaf
      // @ts-expect-error nested read-only leaves are not rule values
      value.nested.display
      return [
        rule.when(value.nested.edit.blank()).effects({
          nested: { edit: { required: true }, display: { hidden: true } },
          leaf: { hidden: true },
          list: { required: true },
        }),
      ]
    })
    const next = flow.next(form)
    const after = new Form(next, "after", {
      role,
      form: ({ value }) => ({
        summary: TextField({
          default: value((state) => {
            const edit: string | undefined = state.nested?.edit
            const row: string | undefined = state.list?.[0]?.edit
            // @ts-expect-error read-only values are absent from process state
            state.leaf
            // @ts-expect-error nested display values are absent from process state
            state.nested?.display
            // @ts-expect-error list display values are absent from process state
            state.list?.[0]?.display
            return edit ?? row ?? ""
          }),
        }),
      }),
    })
    next.next(after).end()
    expect(form.submissionSchema()).not.toHaveProperty("properties.leaf")
    expect(
      (await Effect.runPromise(form.clientFormDefinition())).components,
    ).toHaveProperty("nested")
  })

  it("infers the actual forEach item, completed steps, rule targets and aggregated output", async () => {
    const { role, flow } = setup()
    const perItem = new Form(flow, "review", {
      role,
      forEach: { items: (state) => Effect.succeed(state.rows) },
      form: ({ value }) => ({
        answer: TextField({
          default: value(
            (_state, ctx, item) =>
              `${ctx.step.first.providerUser.email}:${item.name}`,
          ),
        }),
        display: TextField({
          readOnly: true,
          default: value((_state, _ctx, item) => item.name),
        }),
      }),
    }).rules((value, rule) => [
      rule.when(value.answer.blank()).effects({ answer: { required: true } }),
    ])
    const after = new Form(flow.next(perItem), "after", {
      role,
      form: ({ value }) => ({
        accepted: BooleanField({
          default: value((state) => {
            const answers: readonly { readonly answer: string }[] = state.review
            // @ts-expect-error read-only fields never enter the aggregated output
            answers[0]?.display
            return answers.length > 0
          }),
        }),
      }),
    })
    expect(after.isForm).toBe(true)
    expect(perItem.hasForEach).toBe(true)
    expect(
      await Effect.runPromise(
        perItem.resolveDefaults({ name: "start", rows: [] }, completed, {
          name: "actual",
        }),
      ),
    ).toMatchObject({ display: "actual" })
  })

  it("resolves optionalWith text metadata on both sides without changing intrinsic defaults", async () => {
    const { role, flow } = setup()
    let calls = 0
    const form = new Form(flow, "optional-text", {
      role,
      form: ({ value }) => {
        const name = value((state) => {
          calls++
          return state.name
        }, "Static name")
        return {
          name: Schema.optionalWith(TextField({ default: name, label: name }), {
            default: () => "intrinsic",
          }),
          nested: Schema.Struct({
            name: Schema.optionalWith(
              TextField({ default: name, label: name }),
              {
                default: () => "nested intrinsic",
              },
            ),
          }),
        }
      },
    })
    const staticDefinition = await Effect.runPromise(
      form.clientFormDefinition(),
    )
    expect(calls).toBe(0)
    expect(staticDefinition.components["name"]).toMatchObject({
      label: "Static name",
    })
    const state = { name: "Resolved name", rows: [] }
    const fields = form.getFieldsWithState(state, completed)
    expect(calls).toBe(1)
    const schema = Schema.Struct(fields)
    expect(Schema.decodeUnknownSync(schema)({ nested: {} })).toEqual({
      name: "intrinsic",
      nested: { name: "nested intrinsic" },
    })
    expect(
      Schema.decodeUnknownSync(schema)({
        name: undefined,
        nested: { name: undefined },
      }),
    ).toEqual({
      name: "intrinsic",
      nested: { name: "nested intrinsic" },
    })
    const edited = { name: "Edited", nested: { name: "Nested edit" } }
    expect(Schema.decodeUnknownSync(schema)(edited)).toEqual(edited)
    expect(Schema.encodeSync(schema)(edited)).toEqual(edited)
    expect(
      await Effect.runPromise(form.resolveDefaults(state, completed)),
    ).toEqual({
      name: "Resolved name",
      nested: { name: "Resolved name" },
    })
    expect(
      await Effect.runPromise(
        form.clientFormDefinitionWithState(state, completed),
      ),
    ).toMatchObject({
      components: { name: { label: "Resolved name" } },
    })
    expect(await Effect.runPromise(form.clientFormDefinition())).toEqual(
      staticDefinition,
    )
  })

  it("preserves transformed nested Struct fields for typed rules and field reuse", async () => {
    const { role, flow } = setup()
    const form = new Form(flow, "nested-rules", {
      role,
      form: ({ value }) => ({
        staticNested: Schema.Struct({
          name: Schema.optionalWith(TextField(), {
            default: () => "static intrinsic",
          }),
        }),
        dynamicNested: Schema.Struct({
          name: Schema.optionalWith(
            TextField({ default: value((state) => state.name) }),
            {
              default: () => "dynamic intrinsic",
            },
          ),
          count: Schema.optionalWith(Schema.NumberFromString, {
            default: () => 5,
          }),
          renamed: Schema.optionalWith(TextField(), {
            default: () => "renamed intrinsic",
          })
            .pipe(Schema.fromKey("wire_name"))
            .annotations({ [FormLabel]: value((state) => state.name) }),
        }),
      }),
    }).rules((value, rule) => [
      rule
        .when(value.staticNested.name.blank())
        .effects({ staticNested: { name: { required: true } } }),
      rule
        .when(value.dynamicNested.name.blank())
        .effects({ dynamicNested: { name: { required: true } } }),
    ])
    expect(
      Schema.decodeUnknownSync(Schema.Struct(form.output.staticNested.fields))(
        {},
      ),
    ).toEqual({ name: "static intrinsic" })
    const fields = form.getFieldsWithState(
      { name: "Resolved", rows: [] },
      completed,
    )
    const reused = Schema.Struct(fields.dynamicNested.fields)
    expect(Schema.decodeUnknownSync(reused)({})).toEqual({
      name: "dynamic intrinsic",
      count: 5,
      renamed: "renamed intrinsic",
    })
    expect(
      Schema.decodeUnknownSync(reused)({
        name: "Edited",
        count: "12",
        wire_name: "Renamed",
      }),
    ).toEqual({ name: "Edited", count: 12, renamed: "Renamed" })
    expect(
      Schema.encodeSync(reused)({
        name: "Edited",
        count: 12,
        renamed: "Renamed",
      }),
    ).toEqual({ name: "Edited", count: "12", wire_name: "Renamed" })
    expect(fields.dynamicNested.fields.renamed.ast).toMatchObject({
      to: { annotations: { [FormLabel]: "Resolved" } },
    })
    const definition = await Effect.runPromise(
      form.clientFormDefinitionWithState(
        { name: "Resolved", rows: [] },
        completed,
      ),
    )
    expect(definition.rules).toMatchObject([
      {
        effects: [
          { target: ["staticNested", "name"], state: { required: true } },
        ],
      },
      {
        effects: [
          { target: ["dynamicNested", "name"], state: { required: true } },
        ],
      },
    ])
  })

  it("does not discover query factories during metadata resolution and retains override precedence", async () => {
    const { role, flow } = setup()
    let bindings = 0
    const form = new Form(flow, "queries", {
      role,
      form: ({ query }) => ({
        parent: TextField(),
        choice: LookupField({
          query: query((state) => {
            bindings++
            return (filter, limit) =>
              Effect.succeed([
                { value: state.name, label: `${filter}:${limit}` },
              ])
          }),
        }),
        slot: CalendarSlotField({
          timeZone: "UTC",
          query: query(
            (state) => () =>
              Effect.succeed([
                {
                  value: state.name,
                  startsAt: "2026-09-16T00:00:00Z",
                  endsAt: "2026-09-16T01:00:00Z",
                },
              ]),
          ),
        }),
      }),
    })
    const one = { name: "one", rows: [] }
    await Effect.runPromise(form.clientFormDefinition())
    await Effect.runPromise(form.resolveDefaults(one, completed))
    expect(bindings).toBe(0)
    const lookup = form.executeLookupWithState(
      "choice",
      "search",
      10,
      one,
      completed,
    )
    const calendar = form.executeCalendarSlotsWithState(
      "slot",
      { name: "two", rows: [] },
      completed,
    )
    // Query services are intentionally absent; these fixture queries are pure.
    expect(
      await Effect.runPromise(Effect.provide(lookup, emptyServices)),
    ).toEqual([{ value: "one", label: "search:10" }])
    expect(
      await Effect.runPromise(Effect.provide(calendar, emptyServices)),
    ).toMatchObject([{ value: "two" }])
    form.lookups.choice
      .dependsOn([form.lookups.parent])
      .setQuery((input) =>
        Effect.succeed([{ value: input.parent, label: input.parent }]),
      )
    expect(
      await Effect.runPromise(
        Effect.provide(
          form.executeLookupWithState(
            "choice",
            "",
            10,
            one,
            completed,
            undefined,
            { parent: "override" },
          ),
          emptyServices,
        ),
      ),
    ).toEqual([{ value: "override", label: "override" }])
    expect(bindings).toBe(1)
  })

  it("binds optional lookups and validates untyped query results", async () => {
    const { role, process } = setup()
    const form = new Form(process, "optional-query", {
      role,
      form: ({ query }) => ({
        choice: Schema.optional(
          LookupField({
            query: query(
              () => () =>
                Effect.succeed([{ value: "actual", label: "Actual" }]),
            ),
          }),
        ),
      }),
    })
    expect(
      await Effect.runPromise(
        form
          .executeLookupWithState("choice", "", 10, {}, initial)
          .pipe(Effect.provide(emptyServices)),
      ),
    ).toEqual([{ value: "actual", label: "Actual" }])

    const bad = new Form(process, "invalid-query", {
      role,
      form: ({ query }) => ({
        choice: LookupField({
          // @ts-expect-error exercise runtime validation for untyped callers
          query: query(
            () => () => Effect.succeed([{ value: 1, label: "Wrong" }]),
          ),
        }),
      }),
    })
    await expect(
      Effect.runPromise(
        bad
          .executeLookupWithState("choice", "", 10, {}, initial)
          .pipe(Effect.provide(emptyServices)),
      ),
    ).rejects.toThrow()
  })

  it("rejects untyped value-bearing content", () => {
    const { role, process } = setup()
    const form = new Form(process, "bad", {
      role,
      form: ({ content }) => ({
        // @ts-expect-error exercise the runtime guard for untyped callers too
        bad: content(() => TextField({ readOnly: true })),
      }),
    })
    expect(() => form.getFieldsWithState({}, initial)).toThrow(
      FormDecorationError,
    )
  })

  it("preserves transformed struct and wrapper container annotations", async () => {
    const { role, process } = setup()
    const fields = {
      nested: Schema.Struct({
        name: Schema.optionalWith(TextField(), { default: () => "Nested" }),
      }).annotations({
        [FormLabel]: "Nested label",
        [FormDescription]: "Nested description",
      }),
      wrapper: Wrapper({
        flat: TextField(),
      }).annotations({
        [FormLabel]: "Wrapper label",
        [FormDescription]: "Wrapper description",
      }),
    }
    const inline = new Form(process, "annotated-inline", {
      role,
      form: () => fields,
    })
    const definition = await Effect.runPromise(inline.clientFormDefinition())
    expect(definition.components).toMatchObject({
      nested: {
        _tag: "fieldset",
        label: "Nested label",
        description: "Nested description",
      },
      wrapper: {
        _tag: "fieldset",
        label: "Wrapper label",
        description: "Wrapper description",
      },
    })
  })

  it("rejects untyped defaults and deferred schema annotations without publishing them", () => {
    const { role, process } = setup()
    const form = new Form(process, "bad-default", {
      role,
      form: ({ value }) => ({
        // @ts-expect-error also exercise the untyped runtime result guard
        name: TextField({ default: value(() => 42) }),
      }),
    })
    expect(() => form.getFieldsWithState({}, initial)).toThrow(
      FormDecorationError,
    )
    expect(
      () =>
        new Form(process, "bad-classification", {
          role,
          form: ({ value }) => ({
            name: TextField().annotations({
              [FormReadOnly]: value(() => true),
            }),
          }),
        }),
    ).toThrow("deferred value is not allowed")
  })
})

// Constructor contextual typing is the public proof surface, not manually typed helpers.
const rejectedTypes = () => {
  const { role, flow } = setup()
  return new Form(flow, "types", {
    role,
    form: ({ value, content, query }) => ({
      // @ts-expect-error string field defaults must be strings
      wrongDefault: TextField({ default: value(() => 1) }),
      // @ts-expect-error readOnly classification is static
      classification: TextField({ readOnly: value(() => true) }),
      // @ts-expect-error requiredness is static
      required: BooleanField({ required: value(() => true) }),
      // @ts-expect-error value-bearing fields cannot be structural content
      content: content(() => TextField({ readOnly: true })),
      transformed: NumberFieldFrom(Schema.NumberFromString, {
        // @ts-expect-error a transformed field default uses its encoded input
        default: value(() => 12),
      }),
      // @ts-expect-error query results preserve the lookup contract
      lookup: LookupField({ query: query(() => () => Effect.succeed([1])) }),
      name: TextField({
        default: value((state) => {
          // @ts-expect-error process state is inferred, never any
          state.unknown
          return state.name
        }),
      }),
    }),
  })
}
void rejectedTypes

const rejectedDeclarations = (condition: boolean) => {
  const { role, flow } = setup()
  new Form(flow, "conditional", {
    role,
    // @ts-expect-error value-bearing definitions must have definite keys
    form: () => (condition ? { name: TextField() } : { other: TextField() }),
  })
  const optional: { name?: ReturnType<typeof TextField> } = {}
  new Form(flow, "optional", {
    role,
    // @ts-expect-error optional values use Schema.optional, not optional definitions
    form: () => optional,
  })
}
void rejectedDeclarations
