// biome-ignore-all lint/style/noNonNullAssertion: test assertions

import type { AttributeNode, TypeDeclaration } from "./ast.js"
import { parseSource } from "./test-helpers.js"
import { describe, expect, it } from "bun:test"

describe("Init declarations", () => {
  it("should parse init with expression", async () => {
    const source = `
      base unitprice (R10,2).
      base quantity (I5).
      type product = unitprice, quantity.
      type line = product, quantity, unitprice.
      init line its unitprice = product its unitprice.
    `
    const ast = await parseSource(source)

    const lineType = ast.types.find((t: TypeDeclaration) => t.name === "line")
    expect(
      lineType?.attributes.find((a: AttributeNode) => a.name === "unitprice")
        ?.init,
    ).toEqual({
      kind: "path",
      segments: ["product", "unitprice"],
    })
  })
})
