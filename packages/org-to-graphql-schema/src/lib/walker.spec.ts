import { Schema as ES, Effect, Exit } from "effect"
import { MetricBreakdown, RadioField } from "@pf/form-schema"
import { walkOutputAST } from "./output-walker"
import { walkAST } from "./walker"
import { describe, expect, it } from "bun:test"

describe("GraphQL walker", () => {
  it("should generate scalar fields", () => {
    const schema = ES.Struct({
      username: ES.String,
      age: ES.Number,
      active: ES.Boolean,
    })

    const result = Effect.runSync(walkAST(schema.ast, "TestInput"))

    expect(result.main).toContain("input TestInput {")
    expect(result.main).toContain("username: String!")
    expect(result.main).toContain("age: Float!")
    expect(result.main).toContain("active: Boolean!")
    expect(result.auxiliary).toHaveLength(0)
  })

  it("omits undefined and void structural input fields", () => {
    const schema = ES.Struct({
      introduction: ES.Undefined,
      divider: ES.Void,
      username: ES.String,
    })

    const result = Effect.runSync(walkAST(schema.ast, "TestInput"))

    expect(result.main).toBe(`input TestInput {
  username: String!
}`)
  })

  it("should generate string scalar fields for radio literal unions", () => {
    const schema = ES.Struct({
      decision: RadioField({
        options: [
          { value: "approve", label: "Approve" },
          { value: "reject", label: "Reject" },
        ],
      }),
      optionalDecision: ES.optional(
        RadioField({
          options: [
            { value: "yes", label: "Yes" },
            { value: "no", label: "No" },
          ],
        }),
      ),
    })

    const result = Effect.runSync(walkAST(schema.ast, "TestInput"))

    expect(result.main).toContain("decision: String!")
    expect(result.main).toContain("optionalDecision: String")
    expect(result.auxiliary).toHaveLength(0)
  })

  it("should generate output string scalar fields for radio literal unions", () => {
    const schema = ES.Struct({
      decision: RadioField({
        options: [
          { value: "approve", label: "Approve" },
          { value: "reject", label: "Reject" },
        ],
      }),
      optionalDecision: ES.optional(
        RadioField({
          options: [
            { value: "yes", label: "Yes" },
            { value: "no", label: "No" },
          ],
        }),
      ),
    })

    const result = Effect.runSync(walkOutputAST(schema.ast, "TestOutput"))

    expect(result.main).toContain("decision: String!")
    expect(result.main).toContain("optionalDecision: String")
    expect(result.auxiliary).toHaveLength(0)
  })

  it("should reject mixed literal unions instead of dropping branches", () => {
    const schema = ES.Struct({
      mixed: ES.Literal("one", 2),
    })

    const inputResult = Effect.runSyncExit(walkAST(schema.ast, "TestInput"))
    const outputResult = Effect.runSyncExit(
      walkOutputAST(schema.ast, "TestOutput"),
    )

    expect(Exit.isFailure(inputResult)).toBe(true)
    expect(Exit.isFailure(outputResult)).toBe(true)
  })

  it("should generate optional scalar fields for nullable literal unions", () => {
    const schema = ES.Struct({
      decision: ES.Literal("approve", null),
    })

    const inputResult = Effect.runSync(walkAST(schema.ast, "TestInput"))
    const outputResult = Effect.runSync(walkOutputAST(schema.ast, "TestOutput"))

    expect(inputResult.main).toContain("decision: String")
    expect(inputResult.main).not.toContain("decision: String!")
    expect(outputResult.main).toContain("decision: String")
    expect(outputResult.main).not.toContain("decision: String!")
  })

  it("should generate nested input types for structs", () => {
    const schema = ES.Struct({
      address: ES.Struct({
        street: ES.String,
        city: ES.String,
      }),
    })

    const result = Effect.runSync(walkAST(schema.ast, "TestInput"))

    expect(result.main).toContain("address: TestInputAddressInput!")
    expect(result.auxiliary).toHaveLength(1)
    expect(result.auxiliary[0]).toContain("input TestInputAddressInput {")
    expect(result.auxiliary[0]).toContain("street: String!")
    expect(result.auxiliary[0]).toContain("city: String!")
  })

  it("should generate list type with nested input for struct items", () => {
    const schema = ES.Struct({
      students: ES.Array(
        ES.Struct({
          first_name: ES.String,
          parent_email: ES.String,
        }),
      ),
    })

    const result = Effect.runSync(walkAST(schema.ast, "TestInput"))

    expect(result.main).toContain("students: [TestInputStudentsItemInput!]!")
    expect(result.auxiliary).toHaveLength(1)
    expect(result.auxiliary[0]).toContain("input TestInputStudentsItemInput {")
    expect(result.auxiliary[0]).toContain("first_name: String!")
    expect(result.auxiliary[0]).toContain("parent_email: String!")
  })

  it("should generate list type with scalar items", () => {
    const schema = ES.Struct({
      tags: ES.Array(ES.String),
    })

    const result = Effect.runSync(walkAST(schema.ast, "TestInput"))

    expect(result.main).toContain("tags: [String!]!")
    expect(result.auxiliary).toHaveLength(0)
  })

  it("should generate list type with radio literal union items", () => {
    const schema = ES.Struct({
      decisions: ES.Array(ES.Literal("approve", "reject")),
    })

    const result = Effect.runSync(walkAST(schema.ast, "TestInput"))

    expect(result.main).toContain("decisions: [String!]!")
    expect(result.auxiliary).toHaveLength(0)
  })

  it("should skip structural-only output fields", () => {
    const schema = ES.Struct({
      name: ES.String,
      costs: MetricBreakdown({
        title: "Usage costs",
        buckets: [{ label: "CodeBuild", amount: 18.42 }],
      }),
    })

    const result = Effect.runSync(walkOutputAST(schema.ast, "TestOutput"))

    expect(result.main).toContain("name: String!")
    expect(result.main).not.toContain("costs")
    expect(result.auxiliary).toHaveLength(0)
  })

  it("should generate output fields for item-backed metric breakdowns", () => {
    const schema = ES.Struct({
      name: ES.String,
      costs: MetricBreakdown({
        title: "Usage costs",
        dataSource: "item",
        buckets: [{ label: "CodeBuild" }],
      }),
    })

    const result = Effect.runSync(walkOutputAST(schema.ast, "TestOutput"))

    expect(result.main).toContain("name: String!")
    expect(result.main).toContain("costs: TestOutputCosts!")
    expect(result.auxiliary).toHaveLength(3)
    expect(result.auxiliary.join("\n")).toContain("type TestOutputCosts {")
    expect(result.auxiliary.join("\n")).toContain("total: Float!")
    expect(result.auxiliary.join("\n")).toContain(
      "buckets: [TestOutputCostsBucket!]!",
    )
  })
})
