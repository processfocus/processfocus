import { evaluateFormRules } from "./evaluator"
import type { FormRule, FormRuleLiteral, FormRulePath } from "./types"
import { describe, expect, it } from "bun:test"

const path = (...segments: FormRulePath): FormRulePath => segments
const field = (...segments: FormRulePath) =>
  ({ _tag: "field", path: segments }) as const
const baseField = (...segments: FormRulePath) =>
  ({ _tag: "field", path: segments, source: "base" }) as const
const literal = (value: FormRuleLiteral) =>
  ({ _tag: "literal", value }) as const

describe("evaluateFormRules", () => {
  it("evaluates equality, membership, boolean composition, and value comparisons", () => {
    const rules: readonly FormRule[] = [
      {
        condition: {
          _tag: "and",
          expressions: [
            { _tag: "equals", left: field("status"), right: literal("open") },
            {
              _tag: "in",
              value: field("kind"),
              candidates: literal(["urgent", "normal"]),
            },
            {
              _tag: "numberOrder",
              operator: "gte",
              left: field("amount"),
              right: baseField("minimum"),
            },
            {
              _tag: "stringOrder",
              operator: "lt",
              left: field("code"),
              right: literal("m"),
            },
            {
              _tag: "dateOrder",
              operator: "gt",
              left: field("due"),
              right: literal("2026-01-01"),
            },
            {
              _tag: "not",
              expression: {
                _tag: "notEquals",
                left: field("approved"),
                right: literal(true),
              },
            },
            {
              _tag: "notIn",
              value: field("status"),
              candidates: literal(["closed"]),
            },
          ],
        },
        effects: [{ target: path("details"), state: { required: true } }],
      },
    ]

    const result = evaluateFormRules({
      rules,
      values: {
        amount: 12,
        approved: true,
        code: "a",
        due: "2026-02-01",
        kind: "urgent",
        status: "open",
      },
      baseValues: { minimum: 10 },
    })

    expect(result.targets).toEqual([
      { path: path("details"), state: { required: true } },
    ])
  })

  it("merges matching rule effects in author order with later properties winning", () => {
    const rules: readonly FormRule[] = [
      {
        condition: { _tag: "present", value: field("status") },
        effects: [
          { target: path("notes"), state: { hidden: true, required: false } },
        ],
      },
      {
        condition: {
          _tag: "equals",
          left: field("status"),
          right: literal("open"),
        },
        effects: [
          { target: path("notes"), state: { hidden: false, disabled: true } },
        ],
      },
    ]

    const result = evaluateFormRules({
      rules,
      values: { status: "open" },
      baseState: [{ path: path("notes"), state: { disabled: false } }],
    })

    expect(result.targets).toEqual([
      {
        path: path("notes"),
        state: { disabled: true, hidden: false, required: false },
      },
    ])
  })

  it("applies otherwise effects at the rule position when a condition does not match", () => {
    const rules: readonly FormRule[] = [
      {
        condition: {
          _tag: "equals",
          left: field("choice"),
          right: literal("yes"),
        },
        effects: [{ target: path("reason"), state: { hidden: true } }],
        otherwise: [{ target: path("reason"), state: { hidden: false } }],
      },
      {
        condition: { _tag: "present", value: field("choice") },
        effects: [{ target: path("reason"), state: { required: true } }],
      },
    ]

    const result = evaluateFormRules({ rules, values: { choice: "no" } })

    expect(result.targets).toEqual([
      { path: path("reason"), state: { hidden: false, required: true } },
    ])
  })

  it("merges label effects like other state properties", () => {
    const rules: readonly FormRule[] = [
      {
        condition: {
          _tag: "equals",
          left: field("type"),
          right: literal("transfer"),
        },
        effects: [
          {
            target: path("school"),
            state: { label: "Child's current school" },
          },
        ],
        otherwise: [
          {
            target: path("school"),
            state: { label: "Child's kindy (if applicable)" },
          },
        ],
      },
    ]

    const resultTransfer = evaluateFormRules({
      rules,
      values: { type: "transfer" },
    })
    expect(resultTransfer.targets).toEqual([
      {
        path: path("school"),
        state: { label: "Child's current school" },
      },
    ])

    const resultNewEntrant = evaluateFormRules({
      rules,
      values: { type: "new-entrant" },
    })
    expect(resultNewEntrant.targets).toEqual([
      {
        path: path("school"),
        state: { label: "Child's kindy (if applicable)" },
      },
    ])
  })

  it("treats missing and invalid controlling values as unavailable without errors", () => {
    const rules: readonly FormRule[] = [
      {
        condition: {
          _tag: "numberOrder",
          operator: "gt",
          left: field("missing"),
          right: literal(10),
        },
        effects: [{ target: path("amountNote"), state: { hidden: true } }],
        otherwise: [{ target: path("amountNote"), state: { hidden: false } }],
      },
      {
        condition: {
          _tag: "numberOrder",
          operator: "gt",
          left: field("amount"),
          right: literal(10),
        },
        effects: [{ target: path("amount"), state: { disabled: true } }],
        otherwise: [{ target: path("amount"), state: { disabled: false } }],
      },
      {
        condition: {
          _tag: "notIn",
          value: field("missing"),
          candidates: literal(["x"]),
        },
        effects: [{ target: path("negative"), state: { hidden: true } }],
        otherwise: [{ target: path("negative"), state: { hidden: false } }],
      },
      {
        condition: {
          _tag: "not",
          expression: {
            _tag: "numberOrder",
            operator: "gt",
            left: field("amount"),
            right: literal(10),
          },
        },
        effects: [{ target: path("negated"), state: { hidden: true } }],
        otherwise: [{ target: path("negated"), state: { hidden: false } }],
      },
    ]

    const result = evaluateFormRules({ rules, values: { amount: "invalid" } })

    expect(result.targets).toEqual([
      { path: path("amountNote"), state: { hidden: false } },
      { path: path("amount"), state: { disabled: false } },
      { path: path("negative"), state: { hidden: false } },
      { path: path("negated"), state: { hidden: false } },
    ])
  })

  it("uses blank and present semantics for missing, null, empty values, arrays, and false", () => {
    const rules: readonly FormRule[] = [
      blankRule("missing", "missingTarget"),
      blankRule("nullValue", "nullTarget"),
      blankRule("emptyString", "emptyStringTarget"),
      blankRule("emptyArray", "emptyArrayTarget"),
      presentRule("falseValue", "falseTarget"),
    ]

    const result = evaluateFormRules({
      rules,
      values: {
        emptyArray: [],
        emptyString: "",
        falseValue: false,
        nullValue: null,
      },
    })

    expect(result.targets).toEqual([
      { path: path("missingTarget"), state: { hidden: true } },
      { path: path("nullTarget"), state: { hidden: true } },
      { path: path("emptyStringTarget"), state: { hidden: true } },
      { path: path("emptyArrayTarget"), state: { hidden: true } },
      { path: path("falseTarget"), state: { required: true } },
    ])
  })

  it("indexes array values with number path segments and treats star as a normal key", () => {
    const rules: readonly FormRule[] = [
      {
        condition: {
          _tag: "equals",
          left: field("items", 1, "name"),
          right: literal("second"),
        },
        effects: [{ target: path("arrayTarget"), state: { hidden: true } }],
      },
      {
        condition: {
          _tag: "equals",
          left: field("*"),
          right: literal("literal-star"),
        },
        effects: [{ target: path("starTarget"), state: { disabled: true } }],
      },
    ]

    const result = evaluateFormRules({
      rules,
      values: {
        "*": "literal-star",
        items: [{ name: "first" }, { name: "second" }],
      },
    })

    expect(result.targets).toEqual([
      { path: path("arrayTarget"), state: { hidden: true } },
      { path: path("starTarget"), state: { disabled: true } },
    ])
  })

  it("compares membership candidates structurally", () => {
    const rules: readonly FormRule[] = [
      {
        condition: {
          _tag: "in",
          value: field("selected"),
          candidates: literal([
            ["x", "y"],
            ["a", "b"],
          ]),
        },
        effects: [{ target: path("selected"), state: { required: true } }],
      },
    ]

    const result = evaluateFormRules({
      rules,
      values: { selected: ["a", "b"] },
    })

    expect(result.targets).toEqual([
      { path: path("selected"), state: { required: true } },
    ])
  })

  it("treats invalid membership candidates as unavailable", () => {
    const rules: readonly FormRule[] = [
      {
        condition: {
          _tag: "notIn",
          value: field("status"),
          candidates: literal("not-an-array"),
        },
        effects: [{ target: path("status"), state: { hidden: true } }],
        otherwise: [{ target: path("status"), state: { hidden: false } }],
      },
    ]

    const result = evaluateFormRules({ rules, values: { status: "open" } })

    expect(result.targets).toEqual([
      { path: path("status"), state: { hidden: false } },
    ])
  })

  it("uses path arrays without treating dots as nesting separators", () => {
    const rules: readonly FormRule[] = [
      {
        condition: {
          _tag: "equals",
          left: field("applicant.name"),
          right: literal("exact"),
        },
        effects: [
          { target: path("applicant.name"), state: { disabled: true } },
        ],
      },
    ]

    const result = evaluateFormRules({
      rules,
      values: { "applicant.name": "exact", applicant: { name: "nested" } },
    })

    expect(result.targets).toEqual([
      { path: path("applicant.name"), state: { disabled: true } },
    ])
  })

  it("compares serialized array literals structurally", () => {
    const rules: readonly FormRule[] = [
      {
        condition: {
          _tag: "equals",
          left: field("selected"),
          right: literal(["a", "b"]),
        },
        effects: [{ target: path("selected"), state: { required: true } }],
      },
      {
        condition: {
          _tag: "notEquals",
          left: field("numbers"),
          right: literal([1, 2]),
        },
        effects: [{ target: path("numbers"), state: { hidden: true } }],
      },
    ]

    const result = evaluateFormRules({
      rules,
      values: { numbers: [1, 3], selected: ["a", "b"] },
    })

    expect(result.targets).toEqual([
      { path: path("selected"), state: { required: true } },
      { path: path("numbers"), state: { hidden: true } },
    ])
  })

  it("evaluates or expressions and empty boolean expression identities", () => {
    const rules: readonly FormRule[] = [
      {
        condition: {
          _tag: "or",
          expressions: [
            { _tag: "equals", left: field("status"), right: literal("closed") },
            { _tag: "equals", left: field("kind"), right: literal("urgent") },
          ],
        },
        effects: [{ target: path("orTarget"), state: { required: true } }],
      },
      {
        condition: { _tag: "and", expressions: [] },
        effects: [{ target: path("emptyAnd"), state: { hidden: true } }],
      },
      {
        condition: { _tag: "or", expressions: [] },
        effects: [{ target: path("emptyOr"), state: { hidden: true } }],
        otherwise: [{ target: path("emptyOr"), state: { hidden: false } }],
      },
    ]

    const result = evaluateFormRules({ rules, values: { kind: "urgent" } })

    expect(result.targets).toEqual([
      { path: path("orTarget"), state: { required: true } },
      { path: path("emptyAnd"), state: { hidden: true } },
      { path: path("emptyOr"), state: { hidden: false } },
    ])
  })

  it("keeps boolean composition unavailable-aware", () => {
    const rules: readonly FormRule[] = [
      {
        condition: {
          _tag: "or",
          expressions: [
            { _tag: "present", value: field("missing") },
            { _tag: "equals", left: field("kind"), right: literal("urgent") },
          ],
        },
        effects: [{ target: path("orTarget"), state: { hidden: true } }],
      },
      {
        condition: {
          _tag: "and",
          expressions: [
            { _tag: "present", value: field("missing") },
            { _tag: "equals", left: field("kind"), right: literal("normal") },
          ],
        },
        effects: [{ target: path("andTarget"), state: { hidden: true } }],
        otherwise: [{ target: path("andTarget"), state: { hidden: false } }],
      },
      {
        condition: {
          _tag: "equals",
          left: baseField("missingBase"),
          right: literal("value"),
        },
        effects: [{ target: path("baseTarget"), state: { hidden: true } }],
        otherwise: [{ target: path("baseTarget"), state: { hidden: false } }],
      },
    ]

    const result = evaluateFormRules({ rules, values: { kind: "urgent" } })

    expect(result.targets).toEqual([
      { path: path("orTarget"), state: { hidden: true } },
      { path: path("andTarget"), state: { hidden: false } },
      { path: path("baseTarget"), state: { hidden: false } },
    ])
  })

  it("routes fully unavailable boolean composition through otherwise", () => {
    const rules: readonly FormRule[] = [
      {
        condition: {
          _tag: "or",
          expressions: [
            { _tag: "present", value: field("firstMissing") },
            { _tag: "present", value: field("secondMissing") },
          ],
        },
        effects: [{ target: path("orTarget"), state: { hidden: true } }],
        otherwise: [{ target: path("orTarget"), state: { hidden: false } }],
      },
      {
        condition: {
          _tag: "and",
          expressions: [
            { _tag: "equals", left: field("kind"), right: literal("urgent") },
            { _tag: "present", value: field("missing") },
          ],
        },
        effects: [{ target: path("andTarget"), state: { hidden: true } }],
        otherwise: [{ target: path("andTarget"), state: { hidden: false } }],
      },
    ]

    const result = evaluateFormRules({ rules, values: { kind: "urgent" } })

    expect(result.targets).toEqual([
      { path: path("orTarget"), state: { hidden: false } },
      { path: path("andTarget"), state: { hidden: false } },
    ])
  })

  it("routes missing base values through otherwise", () => {
    const rules: readonly FormRule[] = [
      {
        condition: {
          _tag: "equals",
          left: baseField("status"),
          right: literal("open"),
        },
        effects: [{ target: path("baseTarget"), state: { hidden: true } }],
        otherwise: [{ target: path("baseTarget"), state: { hidden: false } }],
      },
    ]

    const result = evaluateFormRules({ rules, values: {} })

    expect(result.targets).toEqual([
      { path: path("baseTarget"), state: { hidden: false } },
    ])
  })

  it("passes through base state entries without matching rules", () => {
    const result = evaluateFormRules({
      rules: [],
      values: {},
      baseState: [{ path: path("existing"), state: { hidden: true } }],
    })

    expect(result.targets).toEqual([
      { path: path("existing"), state: { hidden: true } },
    ])
  })

  it("inherits hidden and disabled state from ancestor targets", () => {
    const rules: readonly FormRule[] = [
      {
        condition: { _tag: "present", value: field("status") },
        effects: [
          { target: path("group"), state: { hidden: true, disabled: true } },
          {
            target: path("group", "child"),
            state: { hidden: false, disabled: false, required: true },
          },
        ],
      },
    ]

    const result = evaluateFormRules({ rules, values: { status: false } })

    expect(result.targets).toEqual([
      { path: path("group"), state: { hidden: true, disabled: true } },
      {
        path: path("group", "child"),
        state: { disabled: true, hidden: true, required: true },
      },
    ])
  })

  it("inherits hidden and disabled state from multi-level ancestors", () => {
    const rules: readonly FormRule[] = [
      {
        condition: { _tag: "present", value: field("status") },
        effects: [
          { target: path("root"), state: { hidden: true } },
          { target: path("root", "group"), state: { disabled: true } },
          {
            target: path("root", "group", "child"),
            state: { hidden: false, disabled: false },
          },
        ],
      },
    ]

    const result = evaluateFormRules({ rules, values: { status: "set" } })

    expect(result.targets).toEqual([
      { path: path("root"), state: { hidden: true } },
      { path: path("root", "group"), state: { disabled: true, hidden: true } },
      {
        path: path("root", "group", "child"),
        state: { disabled: true, hidden: true },
      },
    ])
  })

  it("treats non-ISO date order values as unavailable", () => {
    const rules: readonly FormRule[] = [
      {
        condition: {
          _tag: "dateOrder",
          operator: "gt",
          left: field("date"),
          right: literal("January 1, 2026"),
        },
        effects: [{ target: path("date"), state: { hidden: true } }],
        otherwise: [{ target: path("date"), state: { hidden: false } }],
      },
    ]

    const result = evaluateFormRules({
      rules,
      values: { date: "2026-02-01" },
    })

    expect(result.targets).toEqual([
      { path: path("date"), state: { hidden: false } },
    ])
  })

  it("treats invalid ISO-shaped calendar dates as unavailable", () => {
    const rules: readonly FormRule[] = [
      {
        condition: {
          _tag: "dateOrder",
          operator: "gt",
          left: field("date"),
          right: literal("2026-02-31"),
        },
        effects: [{ target: path("date"), state: { hidden: true } }],
        otherwise: [{ target: path("date"), state: { hidden: false } }],
      },
    ]

    const result = evaluateFormRules({
      rules,
      values: { date: "2026-03-01" },
    })

    expect(result.targets).toEqual([
      { path: path("date"), state: { hidden: false } },
    ])
  })

  it("accepts naive ISO datetime strings as UTC", () => {
    const rules: readonly FormRule[] = [
      {
        condition: {
          _tag: "dateOrder",
          operator: "gt",
          left: field("date"),
          right: literal("2026-02-15T10:30:00"),
        },
        effects: [{ target: path("date"), state: { hidden: true } }],
      },
    ]

    const result = evaluateFormRules({
      rules,
      values: { date: "2026-02-15T10:30:01Z" },
    })

    expect(result.targets).toEqual([
      { path: path("date"), state: { hidden: true } },
    ])
  })

  it("accepts high-precision fractional ISO datetime strings", () => {
    const rules: readonly FormRule[] = [
      {
        condition: {
          _tag: "dateOrder",
          operator: "gt",
          left: field("date"),
          right: literal("2026-02-15T10:30:00.000000Z"),
        },
        effects: [{ target: path("date"), state: { hidden: true } }],
      },
    ]

    const result = evaluateFormRules({
      rules,
      values: { date: "2026-02-15T10:30:00.000001Z" },
    })

    expect(result.targets).toEqual([
      { path: path("date"), state: { hidden: true } },
    ])
  })
})

function blankRule(fieldName: string, target: string): FormRule {
  return {
    condition: { _tag: "blank", value: field(fieldName) },
    effects: [{ target: path(target), state: { hidden: true } }],
  }
}

function presentRule(fieldName: string, target: string): FormRule {
  return {
    condition: { _tag: "present", value: field(fieldName) },
    effects: [{ target: path(target), state: { required: true } }],
  }
}
