import { Schema } from "effect"
import { ListField, TextField, Wrapper } from "@pf/form-schema"
import { prepareExecutableSubmission, withFormRules } from "./executable-rules"
import { describe, expect, it } from "bun:test"

describe("executable submission applicability", () => {
  it("flattens list-item wrappers without flattening ordinary nested objects", () => {
    const schema = withFormRules(
      Schema.Struct({
        flag: Schema.Boolean,
        rows: ListField({
          group: Wrapper({ name: TextField() }),
          nested: Schema.Struct({ name: TextField() }),
        }),
      }),
      () => ({ flag: { label: "Flag" } }),
    )
    const input = {
      flag: true,
      rows: [{ name: "flat", nested: { name: "nested" } }],
    }
    expect(prepareExecutableSubmission(schema, input, {})).toEqual({
      values: input,
      errors: [],
    })
    expect(
      prepareExecutableSubmission(
        schema,
        { flag: true, rows: [{ name: "", nested: { name: "" } }] },
        {},
      ).errors,
    ).toEqual([
      { field: "rows.0.name", message: "Required" },
      { field: "rows.0.nested.name", message: "Required" },
    ])
  })

  it("preserves absent optional and nullable containers while validating present children", () => {
    const schema = withFormRules(
      Schema.Struct({
        flag: Schema.Boolean,
        details: Schema.optional(
          Schema.NullOr(Schema.Struct({ name: Schema.String })),
        ),
      }),
      () => ({ flag: { label: "Flag" } }),
    )
    for (const input of [{ flag: true }, { flag: true, details: null }]) {
      expect(prepareExecutableSubmission(schema, input, {})).toEqual({
        values: input,
        errors: [],
      })
    }
    expect(
      prepareExecutableSubmission(schema, { flag: true, details: {} }, {})
        .errors,
    ).toEqual([{ field: "details.name", message: "Required" }])
  })

  it("validates authoritative disabled rows rather than discarded draft rows", () => {
    const schema = withFormRules(
      Schema.Struct({
        rows: Schema.Array(Schema.Struct({ name: Schema.String })),
      }),
      () => ({ rows: { disabled: true } }),
    )
    const originals = { rows: [{ name: "saved" }] }
    for (const rows of [[], [{ name: "draft" }, { name: "extra" }]]) {
      expect(prepareExecutableSubmission(schema, { rows }, originals)).toEqual({
        values: originals,
        errors: [],
      })
    }
    expect(
      prepareExecutableSubmission(
        schema,
        { rows: [] },
        { rows: [{ name: "" }] },
      ).errors,
    ).toEqual([{ field: "rows.0.name", message: "Required" }])
  })
})
