import { formRuleConditionPaths, formRuleReferencesFieldNames } from "./paths"
import type { FormRule, FormRuleLiteral, FormRulePath } from "./types"
import { describe, expect, it } from "bun:test"

const field = (...path: FormRulePath) => ({ _tag: "field", path }) as const
const literal = (value: FormRuleLiteral) =>
  ({ _tag: "literal", value }) as const

describe("form rule paths", () => {
  it("collects field paths from nested condition variants", () => {
    const paths = formRuleConditionPaths({
      expression: {
        _tag: "and",
        expressions: [
          {
            _tag: "equals",
            left: field("one"),
            right: literal("value"),
          },
          {
            _tag: "or",
            expressions: [
              {
                _tag: "in",
                value: field("two"),
                candidates: field("options"),
              },
              {
                _tag: "not",
                expression: {
                  _tag: "present",
                  value: field("group", "three"),
                },
              },
            ],
          },
          {
            _tag: "dateOrder",
            operator: "gte",
            left: field("date"),
            right: literal("2026-01-01"),
          },
        ],
      },
    })

    expect(paths).toEqual([
      ["one"],
      ["two"],
      ["options"],
      ["group", "three"],
      ["date"],
    ])
  })

  it("checks condition, effect, and otherwise paths", () => {
    const rule: FormRule = {
      condition: {
        _tag: "notEquals",
        left: field("condition"),
        right: literal("value"),
      },
      effects: [{ target: ["effect"], state: { hidden: true } }],
      otherwise: [
        { target: ["otherwise", "nested"], state: { required: true } },
      ],
    }

    expect(
      formRuleReferencesFieldNames({
        rule,
        fieldNames: new Set(["condition"]),
      }),
    ).toBe(true)
    expect(
      formRuleReferencesFieldNames({
        rule,
        fieldNames: new Set(["effect"]),
      }),
    ).toBe(true)
    expect(
      formRuleReferencesFieldNames({
        rule,
        fieldNames: new Set(["otherwise"]),
      }),
    ).toBe(true)
    expect(
      formRuleReferencesFieldNames({
        rule,
        fieldNames: new Set(["unrelated"]),
      }),
    ).toBe(false)
  })

  it("matches dotted field names before falling back to the root field", () => {
    const rule: FormRule = {
      condition: { _tag: "blank", value: field("group", "value") },
      effects: [],
    }

    expect(
      formRuleReferencesFieldNames({
        rule,
        fieldNames: new Set(["group.value"]),
      }),
    ).toBe(true)
    expect(
      formRuleReferencesFieldNames({
        rule,
        fieldNames: new Set(["group"]),
      }),
    ).toBe(true)
  })
})
