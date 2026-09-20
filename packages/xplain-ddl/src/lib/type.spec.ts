// biome-ignore-all lint/style/noNonNullAssertion: test assertions
// biome-ignore-all lint/suspicious/noNonNullAssertedOptionalChain: test assertions

import { parseSource } from "./test-helpers.js"
import { describe, expect, it } from "bun:test"

describe("Type declarations", () => {
  it("should parse simple type", async () => {
    const source = `
      base name (A64).
      type customer = name.
    `
    const ast = await parseSource(source)

    expect(ast.types).toHaveLength(1)
    expect(ast.types[0]!).toMatchObject({
      kind: "type",
      name: "customer",
      attributes: [{ name: "name", baseName: "name", optional: false }],
    })
  })

  it("should parse type with multiple attributes", async () => {
    const source = `
      base name (A64).
      base age (I3).
      type person = name, age.
    `
    const ast = await parseSource(source)

    expect(ast.types[0]?.attributes).toHaveLength(2)
  })

  it("should parse optional attributes", async () => {
    const source = `
      base name (A64).
      type customer = optional name.
    `
    const ast = await parseSource(source)

    expect(ast.types[0]?.attributes[0]?.optional).toBe(true)
  })

  it("should handle derived attributes with underscore", async () => {
    const source = `
      base price (R10,2).
      type product = unit_price.
    `
    const ast = await parseSource(source)

    expect(ast.types[0]?.attributes[0]!).toMatchObject({
      name: "unit_price",
      baseName: "price",
    })
  })

  it("should parse multi-word identifiers", async () => {
    const source = `
      base name (A64).
      type invoice line = name.
    `
    const ast = await parseSource(source)

    expect(ast.types[0]?.name).toBe("invoice line")
  })

  it("should parse type with ID prefix", async () => {
    const source = `
      base task (A64).
      type todo "td" = task.
    `
    const ast = await parseSource(source)

    expect(ast.types).toHaveLength(1)
    expect(ast.types[0]!).toMatchObject({
      kind: "type",
      name: "todo",
      idPrefix: "td",
      attributes: [{ name: "task", baseName: "task", optional: false }],
    })
  })

  it("should parse type without ID prefix", async () => {
    const source = `
      base task (A64).
      type todo = task.
    `
    const ast = await parseSource(source)

    expect(ast.types).toHaveLength(1)
    expect(ast.types[0]!).toMatchObject({
      kind: "type",
      name: "todo",
      attributes: [{ name: "task", baseName: "task", optional: false }],
    })
    expect(ast.types[0]?.idPrefix).toBeUndefined()
  })
})
