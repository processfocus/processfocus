// biome-ignore-all lint/style/noNonNullAssertion: test assertions

import type { AttributeNode, TypeDeclaration } from "./ast.js"
import { parseSource } from "./test-helpers.js"
import { describe, expect, it } from "bun:test"

describe("Complex integration", () => {
  it("should parse complete invoice example", async () => {
    const source = `
      base name (A64).
      base date (D).
      base quantity (I4).
      base unitprice (R10,2).

      type customer = name.
      type product = name, unitprice.
      type invoice = customer, date.
      type invoice line = invoice, product, quantity, unitprice.

      init invoice line its unitprice = product its unitprice.

      assert invoice line its amount (0..*) = quantity * unitprice.

      unique index customer its nameidx = name.
      index invoice its dateidx = date.
    `
    const ast = await parseSource(source)

    expect(ast.bases).toHaveLength(4)
    expect(ast.types).toHaveLength(4)

    const invoiceLine = ast.types.find(
      (t: TypeDeclaration) => t.name === "invoice line",
    )
    expect(invoiceLine).toBeDefined()
    expect(
      invoiceLine?.attributes.find((a: AttributeNode) => a.name === "unitprice")
        ?.init,
    ).toBeDefined()
    expect(invoiceLine?.extends).toHaveLength(1)
    expect(invoiceLine?.extends[0]?.attributeName).toBe("amount")

    const customer = ast.types.find(
      (t: TypeDeclaration) => t.name === "customer",
    )
    expect(customer?.uniqueIndexes).toHaveLength(1)

    const invoice = ast.types.find((t: TypeDeclaration) => t.name === "invoice")
    expect(invoice?.indexes).toHaveLength(1)
  })
})
