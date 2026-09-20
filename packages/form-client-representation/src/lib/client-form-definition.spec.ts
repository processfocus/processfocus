import type { FormRule } from "@pf/form-rule"
import {
  type ClientFormDefinition,
  omitClientFormDefinitionFields,
  parseClientFormDefinition,
} from "./client-form-definition"
import { type FormComponent, FormComponentType } from "./types"
import { describe, expect, it } from "bun:test"

const components = {
  choice: {
    _tag: FormComponentType.Text,
    field: "choice",
    label: "Choice",
  },
} satisfies Record<string, FormComponent>

const rules = [
  {
    condition: {
      _tag: "present",
      value: { _tag: "field", path: ["choice"] },
    },
    effects: [{ target: ["choice"], state: { required: true } }],
  },
] satisfies readonly FormRule[]

describe("client form definition parsing", () => {
  it("parses rule-free and rule-bearing definitions", () => {
    expect(parseClientFormDefinition({ components, rules: [] })).toEqual({
      components,
      rules: [],
    })
    expect(parseClientFormDefinition({ components, rules })).toEqual({
      components,
      rules,
    })
  })

  it("rejects malformed components and rules at the boundary", () => {
    expect(() =>
      parseClientFormDefinition({ components: { choice: [] }, rules: [] }),
    ).toThrow("must be a valid client form definition")
    expect(() =>
      parseClientFormDefinition({ components, rules: [{ effects: [] }] }),
    ).toThrow("must be a valid client form definition")
  })

  it("projects components and drops whole rules that reference omitted fields", () => {
    const safeRule = rules[0]
    if (!safeRule) throw new Error("Expected rule fixture")

    const definition = {
      components: {
        ...components,
        privateChoice: {
          _tag: FormComponentType.Text,
          field: "privateChoice",
          label: "Private choice",
        },
      },
      rules: [
        safeRule,
        {
          condition: {
            _tag: "present",
            value: { _tag: "field", path: ["privateChoice"] },
          },
          effects: [{ target: ["choice"], state: { hidden: true } }],
        },
        {
          condition: {
            _tag: "present",
            value: { _tag: "field", path: ["choice"] },
          },
          effects: [{ target: ["privateChoice"], state: { disabled: true } }],
        },
        {
          condition: {
            _tag: "blank",
            value: { _tag: "field", path: ["choice"] },
          },
          effects: [{ target: ["choice"], state: { required: true } }],
          otherwise: [{ target: ["privateChoice"], state: { hidden: true } }],
        },
      ],
    } satisfies ClientFormDefinition

    expect(
      omitClientFormDefinitionFields(definition, new Set(["privateChoice"])),
    ).toEqual({ components, rules: [safeRule] })
  })
})

it("validates browser-safe fixed dropdown options", () => {
  const field = {
    _tag: FormComponentType.Select,
    field: "category",
    label: "Category",
    options: ["Member", "Guest"],
  } satisfies FormComponent
  expect(
    parseClientFormDefinition({ components: { category: field }, rules: [] })
      .components["category"],
  ).toEqual(field)
  for (const options of [[], [1], [{ value: "Member" }]]) {
    expect(() =>
      parseClientFormDefinition({
        components: { category: { ...field, options } },
        rules: [],
      }),
    ).toThrow()
  }
  expect(() =>
    parseClientFormDefinition({
      components: { category: { ...field, emptyValue: "invalid" } },
      rules: [],
    }),
  ).toThrow()
})
