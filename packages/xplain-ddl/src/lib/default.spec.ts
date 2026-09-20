// biome-ignore-all lint/style/noNonNullAssertion: test assertions

import { parseSource } from "./test-helpers.js"
import { describe, expect, it } from "bun:test"

describe("Default declarations", () => {
  it("should parse default with literal", async () => {
    const source = `
      base name (A64).
      type customer = name.
      default customer its name = "unknown".
    `
    const ast = await parseSource(source)

    expect(ast.types[0]?.attributes[0]?.default).toEqual({
      kind: "literal",
      valueType: "string",
      value: "unknown",
    })
  })

  it("should parse default with systemdate literal", async () => {
    const source = `
      base createddate (D).
      type record = createddate.
      default record its createddate = systemdate.
    `
    const ast = await parseSource(source)

    expect(ast.types[0]?.attributes[0]?.default).toEqual({
      kind: "literal",
      valueType: "systemdate",
      value: "systemdate",
    })
  })

  it("should parse default with boolean true literal", async () => {
    const source = `
      base active (B).
      type item = active.
      default item its active = true.
    `
    const ast = await parseSource(source)

    expect(ast.types[0]?.attributes[0]?.default).toEqual({
      kind: "literal",
      valueType: "boolean",
      value: true,
    })
  })

  it("should parse default with boolean false literal", async () => {
    const source = `
      base enabled (B).
      type feature = enabled.
      default feature its enabled = false.
    `
    const ast = await parseSource(source)

    expect(ast.types[0]?.attributes[0]?.default).toEqual({
      kind: "literal",
      valueType: "boolean",
      value: false,
    })
  })

  it("should parse multiple defaults with systemdate", async () => {
    const source = `
      base queue (A512).
      base job payload (J).
      base job attempts (I4).
      base available at (D).
      base locked until (D).
      
      type job queue = queue, job payload, job attempts, available at, locked until.
      default job queue its job attempts = 0.
      default job queue its available at = systemdate.
      default job queue its locked until = systemdate.
    `
    const ast = await parseSource(source)

    const jobQueue = ast.types[0]!
    expect(jobQueue.name).toBe("job queue")

    const attemptsAttr = jobQueue.attributes.find(
      (a) => a.name === "job attempts",
    )
    expect(attemptsAttr?.default).toEqual({
      kind: "literal",
      valueType: "number",
      value: 0,
    })

    const availableAtAttr = jobQueue.attributes.find(
      (a) => a.name === "available at",
    )
    expect(availableAtAttr?.default).toEqual({
      kind: "literal",
      valueType: "systemdate",
      value: "systemdate",
    })

    const lockedUntilAttr = jobQueue.attributes.find(
      (a) => a.name === "locked until",
    )
    expect(lockedUntilAttr?.default).toEqual({
      kind: "literal",
      valueType: "systemdate",
      value: "systemdate",
    })
  })
})
