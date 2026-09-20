import { parseSource } from "./test-helpers.js"
import { describe, expect, it } from "bun:test"

describe("Comments", () => {
  it("should ignore comments", async () => {
    const source = `
      # This is a comment
      base name (A64). # inline comment
      # Another comment
      type customer = name.
    `
    const ast = await parseSource(source)

    expect(ast.bases).toHaveLength(1)
    expect(ast.types).toHaveLength(1)
  })
})
