import { Effect, Schema } from "effect"
import { EmailField, FormDefault, TextField, Wrapper } from "@pf/form-schema"
import { List, Organisation, Role } from "../.."
import { describe, expect, it } from "bun:test"

const fixture = () => {
  const org = new Organisation({ name: "test" })
  const role = new Role(org, "Office")
  return { org, role }
}

describe("List create contract", () => {
  it("accepts untouched optional and nullable dropdowns from resolved defaults", async () => {
    const { org, role } = fixture()
    const choices = Schema.Literals(["Member", "Guest"])
    const list = new List(org, "optional-choices", {
      name: "Optional choices",
      roles: [role],
      output: { id: Schema.String },
      query: () => Effect.succeed({ items: [], totalCount: 0 }),
      create: {
        form: () => ({
          optional: Schema.optional(choices),
          nullable: Schema.NullOr(choices),
          details: Wrapper({ both: Schema.optional(Schema.NullOr(choices)) }),
        }),
        submit: (input) => {
          expect(input).toEqual({ nullable: null, both: null })
          return Effect.succeed("created")
        },
      },
    })
    const metadata = await Effect.runPromise(list.createFormMetadata())
    expect(metadata?.defaultValues).toEqual({
      optional: undefined,
      nullable: null,
      both: null,
    })
    // JSON transport drops undefined optional values, preserving nullable ones.
    const input: unknown = JSON.parse(JSON.stringify(metadata?.defaultValues))
    const decoded = await Effect.runPromise(
      Schema.decodeUnknownEffect(list.createSubmissionSchema()!)(input),
    )
    expect(await Effect.runPromise(list.executeCreate(decoded))).toBe("created")
  })

  it("projects an independent form, flattens input and excludes server-owned fields", async () => {
    const { org, role } = fixture()
    const list = new List(org, "contacts", {
      name: "Contacts",
      roles: [role],
      output: { id: Schema.String },
      query: () => Effect.succeed({ items: [], totalCount: 0 }),
      form: () => ({
        id: TextField({ readOnly: true }),
        computed: TextField({ readOnly: true }),
      }),
      create: {
        form: () => ({
          details: Wrapper({
            name: TextField().pipe(Schema.check(Schema.isMinLength(1))),
            email: EmailField(),
          }),
          category: Schema.Literals(["Member", "Guest"]).annotate({
            [FormDefault]: "Member",
          }),
          note: Schema.optional(Schema.String),
          generated: TextField({ readOnly: true }),
        }),
        submit: (input) => {
          const email: string = input.email
          const category: "Member" | "Guest" = input.category
          // @ts-expect-error Read-only fields do not belong to create input.
          void input.generated
          // @ts-expect-error Wrapper fields flatten into the submission shape.
          void input.details
          return Effect.succeed(`${email}/${category}`)
        },
      },
    })
    const schema = list.createSubmissionSchema()!
    expect(Object.keys(schema.fields).sort()).toEqual([
      "category",
      "email",
      "name",
      "note",
    ])
    expect(
      Schema.decodeUnknownResult(schema, { onExcessProperty: "error" })({
        name: "Alex",
        email: "alex@example.com",
        category: "Member",
        generated: "override",
      })._tag,
    ).toBe("Failure")
    const metadata = await Effect.runPromise(list.createFormMetadata())
    expect(metadata?.defaultValues["category"]).toBe("Member")
    expect(
      await Effect.runPromise(
        list.executeCreate({
          name: "Alex",
          email: "alex@example.com",
          category: "Guest",
        }),
      ),
    ).toBe("alex@example.com/Guest")
  })

  it("preserves Lists without creation and rejects an empty create input at authoring time", async () => {
    const { org, role } = fixture()
    const base = {
      name: "Legacy",
      roles: [role] as const,
      output: { id: Schema.String },
      query: () => Effect.succeed({ items: [], totalCount: 0 }),
    }
    const list = new List(org, "legacy", base)
    expect(list.hasCreate).toBe(false)
    expect(list.createSubmissionSchema()).toBeNull()
    expect(await Effect.runPromise(list.createFormMetadata())).toBeNull()
    expect(
      () =>
        new List(org, "empty", {
          ...base,
          create: {
            form: () => ({ id: TextField({ readOnly: true }) }),
            submit: () => Effect.succeed("generated"),
          },
        }),
    ).toThrow("at least one submittable field")
  })
})
