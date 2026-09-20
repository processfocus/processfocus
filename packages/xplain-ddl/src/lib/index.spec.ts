// biome-ignore-all lint/style/noNonNullAssertion: test assertions
// biome-ignore-all lint/suspicious/noNonNullAssertedOptionalChain: test assertions

import { parseSource, parseSourceExpectingErrors } from "./test-helpers.js"
import { describe, expect, it } from "bun:test"

describe("Index declarations", () => {
  it("should parse non-unique index", async () => {
    const source = `
      base name (A64).
      type customer = name.
      index customer its idx1 = name.
    `
    const ast = await parseSource(source)

    expect(ast.types[0]?.indexes).toHaveLength(1)
    expect(ast.types[0]?.indexes[0]!).toEqual({
      name: "idx1",
      attributes: ["name"],
      unique: false,
      line: 4,
      column: 7,
    })
  })

  it("should parse unique index", async () => {
    const source = `
      base email (A100).
      type user = email.
      unique index user its email_idx = email.
    `
    const ast = await parseSource(source)

    expect(ast.types[0]?.uniqueIndexes).toHaveLength(1)
    expect(ast.types[0]?.uniqueIndexes[0]?.unique).toBe(true)
  })

  it("should parse multi-column index", async () => {
    const source = `
      base name (A64).
      type person = first_name, last_name.
      index person its name_idx = first_name, last_name.
    `
    const ast = await parseSource(source)

    expect(ast.types[0]?.indexes[0]?.attributes).toEqual([
      "first_name",
      "last_name",
    ])
  })

  it("should reject index with 'its' in attribute list", async () => {
    const source = `
      base name (A64).
      base price (R10,2).
      type product = name.
      type line = product, unit_price.
      index line its line_idx = product its name.
    `
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.length).toBeGreaterThan(0)
      const errorMessage = result.left[0]?.message || ""
      expect(errorMessage).toContain(
        "Index attributes must be simple attribute names",
      )
      expect(errorMessage).toContain(
        "Path expressions using 'its' are not allowed in index definitions",
      )
    }
  })

  it("should reject index with specialization syntax", async () => {
    const source = `
      base name (A64).
      type product = name.
      type line = [product], name.
      index line its line_idx = [product].
    `
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.length).toBeGreaterThan(0)
    }
  })
})
