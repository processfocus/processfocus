// biome-ignore-all lint/style/noNonNullAssertion: test assertions

import { parseSource } from "./test-helpers.js"
import { describe, expect, it } from "bun:test"

describe("Base declarations", () => {
  it("should parse text base (A)", async () => {
    const source = "base name (A64)."
    const ast = await parseSource(source)

    expect(ast.bases).toHaveLength(1)
    expect(ast.bases[0]!).toEqual({
      kind: "base",
      name: "name",
      dataType: { type: "text", maxLength: 64 },
      line: 1,
      column: 1,
    })
  })

  it("should parse boolean base (B)", async () => {
    const source = "base active (B)."
    const ast = await parseSource(source)

    expect(ast.bases[0]?.dataType).toEqual({ type: "boolean" })
  })

  it("should parse datetime base (D)", async () => {
    const source = "base created (D)."
    const ast = await parseSource(source)

    expect(ast.bases[0]?.dataType).toEqual({ type: "datetime" })
  })

  it("should parse integer base (I)", async () => {
    const source = "base quantity (I5)."
    const ast = await parseSource(source)

    expect(ast.bases[0]?.dataType).toEqual({ type: "integer", maxDigits: 5 })
  })

  it("should parse real base (R)", async () => {
    const source = "base price (R10,2)."
    const ast = await parseSource(source)

    expect(ast.bases[0]?.dataType).toEqual({
      type: "real",
      digitsBefore: 10,
      digitsAfter: 2,
    })
  })

  it("should parse unlimited text base (T)", async () => {
    const source = "base description (T)."
    const ast = await parseSource(source)

    expect(ast.bases[0]?.dataType).toEqual({ type: "unlimited_text" })
  })

  it("should parse URN base (U)", async () => {
    const source = "base arn (U)."
    const ast = await parseSource(source)

    expect(ast.bases[0]?.dataType).toEqual({ type: "urn" })
  })

  it("should parse JSON base (J)", async () => {
    const source = "base metadata (J)."
    const ast = await parseSource(source)

    expect(ast.bases[0]?.dataType).toEqual({ type: "json" })
  })

  it("should parse case-insensitive text base (C)", async () => {
    const source = "base name (C256)."
    const ast = await parseSource(source)

    expect(ast.bases[0]?.dataType).toEqual({
      type: "citext",
      maxLength: 256,
    })
  })
})
