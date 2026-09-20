import { DateTime, Effect, Schema } from "effect"
import { buildSchema, printSchema } from "graphql"
import {
  BooleanField,
  LinkButton,
  ListField,
  TextBlock,
  TextField,
  Wrapper,
} from "@pf/form-schema"
import {
  Form,
  type FormAuthoring,
  Organisation,
  Process,
  Role,
  buildFlowContext,
} from "@pf/process"
import { buildFormContractSchema, verifyFormContract } from "../src/testing"
import { describe, expect, it } from "bun:test"

const flowContext = buildFlowContext(
  "contract",
  DateTime.unsafeMake("2026-04-01"),
  [],
)
const context = { ...flowContext, step: {} }
const makeForm = (
  fields: (
    helpers: FormAuthoring<
      { runtime?: boolean },
      Record<string, never>,
      undefined
    >,
  ) => Schema.Struct.Fields,
) => {
  const org = new Organisation({ name: "Contract tests" })
  const role = new Role(org, "reviewer", { name: "Reviewer" })
  const process = new Process(org, "review", {
    name: "Review",
    purpose: "Verify form contracts",
  })
  const form = new Form<{ runtime?: boolean }>(process, "Confirm", {
    name: "Confirm",
    role,
    form: fields,
  })
  process.start(form).end()
  return { org, form }
}

const confirmation = BooleanField({ label: "Confirmed", required: true })

describe("representative form contract helper", () => {
  for (const [name, fields, mismatch] of [
    [
      "added",
      (state: { runtime?: boolean }) => (state.runtime ? { confirmation } : {}),
      "properties",
    ],
    [
      "removed",
      (state: { runtime?: boolean }) => (state.runtime ? {} : { confirmation }),
      "properties",
    ],
    [
      "type",
      (state: { runtime?: boolean }) => ({
        confirmation: state.runtime
          ? TextField({ label: "Confirmed" })
          : confirmation,
      }),
      "confirmation",
    ],
    [
      "optional",
      (state: { runtime?: boolean }) => ({
        confirmation: state.runtime
          ? Schema.optional(confirmation)
          : confirmation,
      }),
      "required",
    ],
    [
      "nested list",
      (state: { runtime?: boolean }) => ({
        people: ListField({
          name: state.runtime ? Schema.Number : Schema.String,
        }),
      }),
      "people.items.properties.name",
    ],
  ] as const) {
    it(`reports the form and mismatched path for ${name} fields`, async () => {
      const { org, form } = makeForm(() => fields({}))
      await expect(
        verifyFormContract({
          schema: await buildFormContractSchema(org),
          // Deliberately corrupt a consumer projection to test the helper's
          // diagnostics; production Forms cannot replace their runtime schema.
          form: {
            node: form.node,
            submissionSchema: () => form.submissionSchema(),
            getFieldsWithState: () => fields({ runtime: true }),
          },
          fixtures: [
            {
              name: "runtime branch",
              args: [],
              input: {},
            },
          ],
        }),
      ).rejects.toThrow(
        new RegExp(
          `review/Confirm.*runtime branch.*${mismatch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
        ),
      )
    })
  }

  it("allows structural branches, flattened wrappers, read-only fields and nested submissions", async () => {
    const { org, form } = makeForm(({ content }) => ({
      presentation: content(
        (state) =>
          state.runtime ? LinkButton("https://example.com", "Open") : undefined,
        TextBlock("Fallback"),
      ),
      details: Wrapper({
        confirmation,
        display: TextField({ label: "Read only", readOnly: true }),
        people: ListField({
          name: TextField({ label: "Name" }),
          note: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      }),
    }))
    const schema = await buildFormContractSchema(org)
    await verifyFormContract({
      schema,
      form,
      fixtures: [
        {
          name: "fallback",
          args: [{}, context],
          input: { confirmation: true, people: [{ name: "Pat" }] },
        },
        {
          name: "link",
          args: [{ runtime: true }, context],
          input: {
            confirmation: true,
            people: [{ name: "Casey", note: null }],
          },
        },
      ],
    })
  })

  it("shares optional read-only filtering across Effect, JSON and GraphQL while retaining display defaults", async () => {
    const children = {
      edit: TextField(),
      display: Schema.optional(
        TextField({ readOnly: true, default: "display" }),
      ),
      help: TextBlock("Help"),
    }
    const { org, form } = makeForm(() => ({
      leaf: Schema.optional(TextField({ readOnly: true, default: "leaf" })),
      nested: Schema.optional(Schema.Struct(children)),
      list: Schema.optional(ListField(children)),
    }))
    const schema = await buildFormContractSchema(org)
    await verifyFormContract({
      schema,
      form,
      fixtures: [
        { name: "omitted", args: [{}, context], input: {} },
        {
          name: "provided",
          args: [{}, context],
          input: {
            nested: { edit: "ok" },
            list: [{ edit: "one" }, { edit: "two" }],
          },
        },
      ],
    })
    const sdl = printSchema(schema)
    expect(sdl).not.toContain("leaf:")
    expect(sdl).not.toContain("display:")
    expect(sdl).not.toContain("help:")
    expect(JSON.stringify(form.submissionSchema())).not.toMatch(
      /"(leaf|display|help)"/,
    )
    expect(
      Schema.decodeUnknownSync(Schema.make(form.submissionEffectSchema.ast))({
        leaf: "client",
        nested: { edit: "ok", display: "client" },
        list: [{ edit: "one", display: "client" }],
      }),
    ).toEqual({ nested: { edit: "ok" }, list: [{ edit: "one" }] })
    expect(
      await Effect.runPromise(form.resolveDefaults({}, context)),
    ).toMatchObject({ leaf: "leaf", nested: { display: "display" } })
    expect(
      (await Effect.runPromise(form.clientFormDefinition())).components,
    ).toHaveProperty("leaf")
  })

  for (const replacement of [
    "confirmation: String!",
    "confirmation: Boolean",
  ]) {
    it(`rejects incompatible generated GraphQL ${replacement}`, async () => {
      const { org, form } = makeForm(() => ({ confirmation }))
      const schema = buildSchema(
        printSchema(await buildFormContractSchema(org)).replace(
          "confirmation: Boolean!",
          replacement,
        ),
      )
      await expect(
        verifyFormContract({
          schema,
          form,
          fixtures: [
            {
              name: "confirmation",
              args: [{}, context],
              input: { confirmation: true },
            },
          ],
        }),
      ).rejects.toThrow(/review\/Confirm.*GraphQL.*confirmation/)
    })
  }

  it("rejects Int for unrestricted numbers even when the fixture is an integer", async () => {
    const { org, form } = makeForm(() => ({ amount: Schema.Number }))
    const generated = await buildFormContractSchema(org)
    await verifyFormContract({
      schema: generated,
      form,
      fixtures: [
        { name: "fraction", args: [{}, context], input: { amount: 1.5 } },
      ],
    })
    const schema = buildSchema(
      printSchema(generated).replace("amount: Float!", "amount: Int!"),
    )
    await expect(
      verifyFormContract({
        schema,
        form,
        fixtures: [
          { name: "integer", args: [{}, context], input: { amount: 1 } },
        ],
      }),
    ).rejects.toThrow(/review\/Confirm.*GraphQL.*amount.*number.*Int/)
  })

  it("reports submission JSON Schema drift independently of GraphQL", async () => {
    const { org, form } = makeForm(() => ({ confirmation }))
    await expect(
      verifyFormContract({
        schema: await buildFormContractSchema(org),
        form: {
          node: form.node,
          getFieldsWithState: (
            ...args: Parameters<typeof form.getFieldsWithState>
          ) => form.getFieldsWithState(...args),
          submissionSchema: () => ({
            ...form.submissionSchema(),
            required: [],
          }),
        },
        fixtures: [
          {
            name: "requiredness",
            args: [{}, context],
            input: { confirmation: true },
          },
        ],
      }),
    ).rejects.toThrow(/review\/Confirm.*submissionSchema mismatch: required/)
  })
})
