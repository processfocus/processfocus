// biome-ignore-all lint/style/noNonNullAssertion: test assertions

import { parseSource, parseSourceExpectingErrors } from "./test-helpers.js"
import { describe, expect, it } from "bun:test"

describe("Assert declarations", () => {
  it("should parse assert with cardinality", async () => {
    const source = `
      base quantity (I5).
      base price (R10,2).
      type line = quantity, unit_price.
      assert line its amount (0..*) = quantity * unit_price.
    `
    const ast = await parseSource(source)

    const lineType = ast.types.find((t) => t.name === "line")!
    expect(lineType.extends).toHaveLength(1)
    expect(lineType.extends[0]!).toMatchObject({
      attributeName: "amount",
      cardinality: { min: 0, max: "unbounded" },
    })
  })

  it("should parse assert with bounded cardinality", async () => {
    const source = `
      base value (I5).
      type data = value.
      assert data its computed (1..100) = value * 2.
    `
    const ast = await parseSource(source)

    const dataType = ast.types.find((t) => t.name === "data")!
    expect(dataType.extends[0]?.cardinality).toEqual({ min: 1, max: 100 })
  })

  it("should parse boolean assert as a static constraint", async () => {
    const source = `
      base name (A64).
      type user = name.
      type external participant = name.
      type process state = optional started by_user, optional started by_external participant.
      assert process state its single starter (true) = started by_user == nil or started by_external participant == nil.
    `
    const ast = await parseSource(source)

    const processStateType = ast.types.find((t) => t.name === "process state")!
    expect(processStateType.asserts).toHaveLength(1)
    expect(processStateType.asserts[0]!).toMatchObject({
      name: "single starter",
      expression: {
        kind: "binary_op",
        operator: "or",
      },
    })
    expect(processStateType.extends).toHaveLength(0)
  })

  it("should reject static asserts that reference unknown attributes", async () => {
    const source = `
      base name (A64).
      type process state = optional name.
      assert process state its single starter (true) = missing attribute == nil.
    `
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Left")
    if (result._tag !== "Left") {
      throw new Error("Expected validation errors")
    }
    expect(result.left[0]?.message).toContain(
      "Identifier 'missing attribute' not found in type 'process state' for assert 'single starter'",
    )
  })

  it("should reject static asserts that are not boolean expressions", async () => {
    const source = `
      base value (I5).
      type data = value.
      assert data its positive (true) = value + 1.
    `
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Left")
    if (result._tag !== "Left") {
      throw new Error("Expected validation errors")
    }
    expect(result.left[0]?.message).toContain("must be a boolean expression")
  })

  it("should reject static asserts that traverse unrelated paths", async () => {
    const source = `
      base name (A64).
      type user = name.
      type process state = optional started by_user.
      assert process state its single starter (true) = started by_user its name == nil.
    `
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Left")
    if (result._tag !== "Left") {
      throw new Error("Expected validation errors")
    }
    expect(result.left[0]?.message).toContain(
      "can only reference attributes on the same type",
    )
  })
})
