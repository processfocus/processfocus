// biome-ignore-all lint/style/noNonNullAssertion: test assertions

import type { TypeDeclaration } from "./ast.js"
import { parseSource, parseSourceExpectingErrors } from "./test-helpers.js"
import { describe, expect, it } from "bun:test"

describe("Extend declarations", () => {
  it("should parse simple extend with calculation", async () => {
    const source = `
      base quantity (I5).
      base unitprice (R10,2).
      type line = quantity, unitprice.
      extend line with amount = quantity * unitprice.
    `
    const ast = await parseSource(source)

    expect(ast.types).toHaveLength(1)
    const line = ast.types[0]!
    expect(line.extends).toHaveLength(1)
    expect(line.extends[0]!.attributeName).toBe("amount")
    expect(line.extends[0]!.expression.kind).toBe("binary_op")
  })

  it("should parse extend with sum retrieval function", async () => {
    const source = `
      base name (A64).
      base quantity (I5).
      base unitprice (R10,2).
      type invoice = name.
      type invoice line = invoice, quantity, unitprice.
      extend invoice line with amount = quantity * unitprice.
      extend invoice with invoicesum = total invoice line its amount per invoice.
    `
    const ast = await parseSource(source)

    const invoice = ast.types.find(
      (t: TypeDeclaration) => t.name === "invoice",
    )!
    expect(invoice.extends).toHaveLength(1)
    expect(invoice.extends[0]!.attributeName).toBe("invoicesum")

    const expr = invoice.extends[0]!.expression
    expect(expr.kind).toBe("retrieval_function")
    if (expr.kind === "retrieval_function") {
      expect(expr.function).toBe("total")
      expect(expr.typeName).toBe("invoice line")
      expect(expr.expression?.kind).toBe("identifier")
      if (expr.expression?.kind === "identifier") {
        expect(expr.expression.name).toBe("amount")
      }
      expect(expr.perPath.kind).toBe("path")
      expect(expr.perPath.segments).toEqual(["invoice"])
    }
  })

  it("should parse extend with calculation in retrieval function", async () => {
    const source = `
      base quantity (I5).
      base price (R10,2).
      type invoice = name.
      type invoice line = invoice, quantity, unit_price.
      base name (A64).
      extend invoice with invoicetotal = total invoice line its quantity * unit_price * 1.2 per invoice.
    `
    const ast = await parseSource(source)

    const invoice = ast.types.find(
      (t: TypeDeclaration) => t.name === "invoice",
    )!
    expect(invoice.extends).toHaveLength(1)

    const expr = invoice.extends[0]!.expression
    expect(expr.kind).toBe("retrieval_function")
    if (expr.kind === "retrieval_function") {
      expect(expr.function).toBe("total")
      expect(expr.expression?.kind).toBe("binary_op")
    }
  })

  it("should parse extend with count retrieval function", async () => {
    const source = `
      base name (A64).
      type invoice = name.
      type invoice line = invoice, name.
      extend invoice with linecount = count invoice line its name per invoice.
    `
    const ast = await parseSource(source)

    const invoice = ast.types.find(
      (t: TypeDeclaration) => t.name === "invoice",
    )!
    expect(invoice.extends).toHaveLength(1)

    const expr = invoice.extends[0]!.expression
    expect(expr.kind).toBe("retrieval_function")
    if (expr.kind === "retrieval_function") {
      expect(expr.function).toBe("count")
      expect(expr.typeName).toBe("invoice line")
      expect(expr.expression?.kind).toBe("identifier")
      if (expr.expression?.kind === "identifier") {
        expect(expr.expression.name).toBe("name")
      }
      expect(expr.perPath.kind).toBe("path")
      expect(expr.perPath.segments).toEqual(["invoice"])
    }
  })

  it("should parse extend with complex per path", async () => {
    const source = `
      base name (A64).
      base value (I5).
      type a = name.
      type b = a.
      type c = b, value.
      extend a with valuetotal = total c its value per b its a.
    `
    const ast = await parseSource(source)

    const typeA = ast.types.find((t: TypeDeclaration) => t.name === "a")!
    expect(typeA.extends).toHaveLength(1)

    const expr = typeA.extends[0]!.expression
    expect(expr.kind).toBe("retrieval_function")
    if (expr.kind === "retrieval_function") {
      expect(expr.perPath.segments).toEqual(["b", "a"])
    }
  })

  it("should parse all retrieval function types", async () => {
    const source = `
      base value (I5).
      type parent = value.
      type child = parent, value.

      extend parent with totalval = total child its value per parent.
      extend parent with maxval = max child its value per parent.
      extend parent with minval = min child its value per parent.
      extend parent with someval = some child its value per parent.
      extend parent with countval = count child its value per parent.
      extend parent with nilval = nil child its value per parent.
      extend parent with anyval = any child its value per parent.
    `
    const ast = await parseSource(source)

    const parent = ast.types.find((t: TypeDeclaration) => t.name === "parent")!
    expect(parent.extends).toHaveLength(7)

    const functions = parent.extends.map((e) =>
      e.expression.kind === "retrieval_function" ? e.expression.function : null,
    )
    expect(functions).toEqual([
      "total",
      "max",
      "min",
      "some",
      "count",
      "nil",
      "any",
    ])
  })

  it("should reject extend with duplicate virtual attribute names", async () => {
    const source = `
      base value (I5).
      type t = value.
      extend t with computed = value * 2.
      extend t with computed = value * 3.
    `
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.length).toBeGreaterThan(0)
      expect(result.left[0]?.message).toContain("Duplicate virtual attribute")
    }
  })

  it("should reject extend conflicting with regular attribute", async () => {
    const source = `
      base value (I5).
      type t = value.
      extend t with value = value * 2.
    `
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.length).toBeGreaterThan(0)
      expect(result.left[0]?.message).toContain(
        "conflicts with regular attribute",
      )
    }
  })

  it("should validate extend expression references", async () => {
    const source = `
      base value (I5).
      type t = value.
      extend t with computed = nonexistent * 2.
    `
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.length).toBeGreaterThan(0)
    }
  })

  it("should reject extend on base types", async () => {
    const source = `
      base value (I5).
      extend value with computed = value * 2.
    `
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.length).toBeGreaterThan(0)
      expect(result.left[0]?.message).toContain("Cannot extend base")
    }
  })

  it("should reject perPath with non-existent attribute", async () => {
    const source = `
      base value (I5).
      type parent = value.
      type child = parent, value.
      extend parent with totalval = total child its value per nonexistent.
    `
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.length).toBeGreaterThan(0)
      expect(result.left[0]?.message).toContain(
        "perPath attribute 'nonexistent' not found",
      )
    }
  })

  it("should reject perPath with non-type attribute", async () => {
    const source = `
      base name (A64).
      base value (I5).
      type parent = name.
      type child = parent, value.
      extend parent with totalval = total child its value per value.
    `
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.length).toBeGreaterThan(0)
      expect(result.left[0]?.message).toContain("must be a type reference")
    }
  })

  it("should accept perPath with role prefix", async () => {
    const source = `
      base value (I5).
      type a = value.
      type b = target_a, value.
      extend a with totalval = total b its value per target_a.
    `
    const ast = await parseSource(source)

    const typeA = ast.types.find((t: TypeDeclaration) => t.name === "a")!
    expect(typeA.extends).toHaveLength(1)

    const expr = typeA.extends[0]!.expression
    expect(expr.kind).toBe("retrieval_function")
    if (expr.kind === "retrieval_function") {
      expect(expr.perPath.segments).toEqual(["target_a"])
    }
  })

  it("should reject perPath chain with non-existent middle attribute", async () => {
    const source = `
      base value (I5).
      type a = value.
      type b = a, value.
      type c = b, value.
      extend a with totalval = total c its value per b its nonexistent.
    `
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.length).toBeGreaterThan(0)
      expect(result.left[0]?.message).toContain(
        "perPath attribute 'nonexistent' not found in type 'b'",
      )
    }
  })

  it("should reject perPath chain where middle attribute is not a type", async () => {
    const source = `
      base name (A64).
      base value (I5).
      type a = value.
      type b = a, name.
      type c = b, value.
      extend a with totalval = total c its value per b its name.
    `
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.length).toBeGreaterThan(0)
      expect(result.left[0]?.message).toContain("must be a type reference")
    }
  })

  it("should provide helpful error when using 'its' instead of 'with' in extend", async () => {
    const source = `
      base value (I5).
      type t = value.
      extend t its computed = value * 2.
    `
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.length).toBeGreaterThan(0)
      const errorMessage = result.left[0]?.message || ""
      expect(errorMessage).toContain("Use 'with' instead of 'its'")
      expect(errorMessage).toContain("extend <type> with <attribute>")
    }
  })
})
