// biome-ignore-all lint/style/noNonNullAssertion: test assertions

import { parseSource } from "./test-helpers.js"
import { describe, expect, it } from "bun:test"

describe("Expression parsing", () => {
  it("should parse arithmetic expressions", async () => {
    const source = `
      base a (I5).
      base b (I5).
      type t = a, b.
      assert t its result (0..*) = a + b * 2.
    `
    const ast = await parseSource(source)

    const tType = ast.types.find((t) => t.name === "t")!
    const expr = tType.extends[0]?.expression
    expect(expr?.kind).toBe("binary_op")
    if (expr?.kind === "binary_op") {
      expect(expr.operator).toBe("+")
      expect(expr.left).toEqual({ kind: "identifier", name: "a" })
      expect(expr.right.kind).toBe("binary_op")
    }
  })

  it("should parse conditional expressions", async () => {
    const source = `
      base quantity (I5).
      base price (R10,2).
      type line = quantity, unit_price.
      assert line its discount (0..*) = if quantity >= 100 then unit_price * 0.8 else unit_price.
    `
    const ast = await parseSource(source)

    const lineType = ast.types.find((t) => t.name === "line")!
    const expr = lineType.extends[0]?.expression
    expect(expr?.kind).toBe("conditional")
    if (expr?.kind === "conditional") {
      expect(expr.condition.kind).toBe("binary_op")
      expect(expr.thenExpr.kind).toBe("binary_op")
      expect(expr.elseExpr).toEqual({ kind: "identifier", name: "unit_price" })
    }
  })

  it("should parse path expressions", async () => {
    const source = `
      base name (A64).
      base price (R10,2).
      type product = name, unit_price.
      type line = product.
      assert line its price (0..*) = product its unit_price.
    `
    const ast = await parseSource(source)

    const lineType = ast.types.find((t) => t.name === "line")!
    const expr = lineType.extends[0]?.expression
    expect(expr).toEqual({
      kind: "path",
      segments: ["product", "unit_price"],
    })
  })

  it("should parse comparison operators", async () => {
    const source = `
      base a (I5).
      base b (I5).
      type t = a, b.
      assert t its r1 (0..*) = a >= b.
      assert t its r2 (0..*) = a <= b.
      assert t its r3 (0..*) = a > b.
      assert t its r4 (0..*) = a < b.
      assert t its r5 (0..*) = a == b.
      assert t its r6 (0..*) = a != b.
    `
    const ast = await parseSource(source)

    const tType = ast.types.find((t) => t.name === "t")!
    expect(tType.extends).toHaveLength(6)
    const operators = tType.extends.map((ext) =>
      ext.expression.kind === "binary_op" ? ext.expression.operator : null,
    )
    expect(operators).toEqual([">=", "<=", ">", "<", "==", "!="])
  })
})
