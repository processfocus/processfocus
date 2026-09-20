// biome-ignore-all lint/style/noNonNullAssertion: test assertions
// biome-ignore-all lint/suspicious/noNonNullAssertedOptionalChain: test assertions

import { parseSource, parseSourceExpectingErrors } from "./test-helpers.js"
import { describe, expect, it } from "bun:test"

describe("Specialization declarations", () => {
  it("should parse specialization with square brackets", async () => {
    const source = `
      base name (A64).
      type building = name.
      type house = [building].
    `
    const ast = await parseSource(source)

    expect(ast.types).toHaveLength(2)
    expect(ast.types[1]!).toMatchObject({
      kind: "type",
      name: "house",
      attributes: [
        {
          name: "building",
          baseName: "building",
          optional: false,
          isSpecialization: true,
        },
      ],
    })
  })

  it("should parse specialization with role prefix", async () => {
    const source = `
      base name (A64).
      type building = name.
      type office = [commercial_building].
    `
    const ast = await parseSource(source)

    expect(ast.types[1]?.attributes[0]!).toMatchObject({
      name: "commercial_building",
      baseName: "building",
      isSpecialization: true,
    })
  })

  it("should parse multiple specializations", async () => {
    const source = `
      base name (A64).
      type building = name.
      type vehicle = name.
      type house = [building], [vehicle].
    `
    const ast = await parseSource(source)

    expect(ast.types[2]?.attributes).toHaveLength(2)
    expect(ast.types[2]?.attributes[0]?.isSpecialization).toBe(true)
    expect(ast.types[2]?.attributes[1]?.isSpecialization).toBe(true)
  })

  it("should allow mixing regular attributes and specializations", async () => {
    const source = `
      base name (A64).
      base address (A128).
      type building = name.
      type house = address, [building].
    `
    const ast = await parseSource(source)

    expect(ast.types[1]?.attributes).toHaveLength(2)
    expect(ast.types[1]?.attributes[0]?.isSpecialization).toBe(false)
    expect(ast.types[1]?.attributes[1]?.isSpecialization).toBe(true)
  })

  it("should reject specialization of a base type", async () => {
    const source = `
      base name (A64).
      type house = [name].
    `
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.length).toBeGreaterThan(0)
      expect(result.left[0]?.message).toContain("cannot reference base")
      expect(result.left[0]?.message).toContain(
        "Specializations must reference types",
      )
    }
  })

  it("should reject optional specialization", async () => {
    const source = `
      base name (A64).
      type building = name.
      type house = optional [building].
    `
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.length).toBeGreaterThan(0)
      expect(result.left[0]?.message).toContain("cannot be optional")
      expect(result.left[0]?.message).toContain("0..1 relationships")
    }
  })

  it("should reject specialization referencing non-existent type", async () => {
    const source = `
      base name (A64).
      type house = [building].
    `
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.length).toBeGreaterThan(0)
      expect(result.left[0]?.message).toContain("not found")
    }
  })

  it("should parse specialization with multi-word type names", async () => {
    const source = `
      base name (A64).
      type commercial building = name.
      type office = [commercial building].
    `
    const ast = await parseSource(source)

    expect(ast.types[1]?.attributes[0]!).toMatchObject({
      name: "commercial building",
      baseName: "commercial building",
      isSpecialization: true,
    })
  })

  it("should handle complex example from documentation", async () => {
    const source = `
      base name (A64).
      base address (A128).
      
      type building = name, address.
      type house = [building].
      type office = [building].
    `
    const ast = await parseSource(source)

    expect(ast.types).toHaveLength(3)
    expect(ast.types[0]?.name).toBe("building")
    expect(ast.types[1]?.name).toBe("house")
    expect(ast.types[2]?.name).toBe("office")

    // Both house and office specialize building
    expect(ast.types[1]?.attributes[0]!).toMatchObject({
      name: "building",
      baseName: "building",
      isSpecialization: true,
    })
    expect(ast.types[2]?.attributes[0]!).toMatchObject({
      name: "building",
      baseName: "building",
      isSpecialization: true,
    })
  })
})
