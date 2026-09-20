import { parseSourceExpectingErrors } from "./test-helpers.js"
import { describe, expect, it } from "bun:test"

describe("Error handling", () => {
  it("should reject base names with underscores", async () => {
    const source = "base org_unit (A32)."
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.length).toBeGreaterThan(0)
    }
  })

  it("should reject type names with underscores", async () => {
    const source = `
      base name (A64).
      type process_step = name.
    `
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.length).toBeGreaterThan(0)
    }
  })

  it("should report lexer errors", async () => {
    const source = "base name (@@@)."
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.length).toBeGreaterThan(0)
    }
  })

  it("should report parser errors", async () => {
    const source = "base name" // Missing data type and period
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.length).toBeGreaterThan(0)
    }
  })

  it("should report semantic error for missing base", async () => {
    const source = `
      type customer = name.
    `
    const result = await parseSourceExpectingErrors(source)

    // Should fail with semantic errors about missing base
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.length).toBeGreaterThan(0)
    }
  })

  it("should report semantic error for missing type in index", async () => {
    const source = `
      base name (A64).
      index customer its idx1 = name.
    `
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.length).toBeGreaterThan(0)
    }
  })

  it("should report semantic error for invalid cardinality", async () => {
    const source = `
      base value (I5).
      type t = value.
      assert t its result (10..5) = value * 2.
    `
    const result = await parseSourceExpectingErrors(source)

    // Should fail with semantic errors about invalid cardinality
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.length).toBeGreaterThan(0)
    }
  })

  it("should report semantic error for empty ID prefix", async () => {
    const source = `
      base task (A64).
      type todo "" = task.
    `
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.length).toBeGreaterThan(0)
      expect(result.left[0]?.message).toContain("cannot be empty")
    }
  })

  it("should report semantic error for ID prefix with non-letters", async () => {
    const source = `
      base task (A64).
      type todo "td-1" = task.
    `
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.length).toBeGreaterThan(0)
      expect(result.left[0]?.message).toContain(
        "must contain only lowercase letters",
      )
    }
  })

  it("should report semantic error for ID prefix longer than 4 characters", async () => {
    const source = `
      base task (A64).
      type todo "todos" = task.
    `
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.length).toBeGreaterThan(0)
      expect(result.left[0]?.message).toContain(
        "cannot be longer than 4 characters",
      )
    }
  })

  it("should report semantic error for ID prefix with uppercase", async () => {
    const source = `
      base task (A64).
      type todo "TODO" = task.
    `
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.length).toBeGreaterThan(0)
      expect(result.left[0]?.message).toContain(
        "must contain only lowercase letters",
      )
    }
  })

  it("should detect simple cycle between two types", async () => {
    const source = `
      type a = b.
      type b = a.
    `
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.length).toBeGreaterThan(0)
      const cycleError = result.left.find((err) =>
        err.message.includes("Cycle detected"),
      )
      expect(cycleError).toBeDefined()
      expect(cycleError?.message).toContain("a -> b -> a")
    }
  })

  it("should detect cycle with three types", async () => {
    const source = `
      type a = b.
      type b = c.
      type c = a.
    `
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.length).toBeGreaterThan(0)
      const cycleError = result.left.find((err) =>
        err.message.includes("Cycle detected"),
      )
      expect(cycleError).toBeDefined()
      expect(cycleError?.message).toContain("a -> b -> c -> a")
    }
  })

  it("should allow self-references (tree structures)", async () => {
    const source = `
      base value (I5).
      type node = value, parent_node.
    `
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Right")
  })

  it("should reject 'optional' keyword on self-references", async () => {
    const source = `
      base value (I5).
      type node = value, optional parent_node.
    `
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.length).toBeGreaterThan(0)
      const selfRefError = result.left.find((err) =>
        err.message.includes("Self-reference"),
      )
      expect(selfRefError).toBeDefined()
      expect(selfRefError?.message).toContain(
        "cannot use the 'optional' keyword",
      )
      expect(selfRefError?.message).toContain("implicitly optional")
    }
  })

  it("should allow types that reference other types without cycles", async () => {
    const source = `
      base name (A64).
      type customer = name.
      type invoice = customer.
    `
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Right")
  })

  it("should detect cycle in complex graph", async () => {
    const source = `
      base name (A64).
      type a = name, b.
      type b = c.
      type c = name, d.
      type d = b.
    `
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.length).toBeGreaterThan(0)
      const cycleError = result.left.find((err) =>
        err.message.includes("Cycle detected"),
      )
      expect(cycleError).toBeDefined()
    }
  })

  it("should detect cycle with specialization references", async () => {
    const source = `
      base name (A64).
      type person = name, [employee].
      type employee = name, [person].
    `
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.length).toBeGreaterThan(0)
      const cycleError = result.left.find((err) =>
        err.message.includes("Cycle detected"),
      )
      expect(cycleError).toBeDefined()
    }
  })

  it("should report helpful error for integer type without digits", async () => {
    const source = "base job attempts (I)."
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.length).toBeGreaterThan(0)
      expect(result.left[0]?.message).toContain(
        "Integer type (I) requires the maximum number of digits",
      )
      expect(result.left[0]?.message).toContain("I<digits>")
      expect(result.left[0]?.message).toContain("I10")
    }
  })

  it("should report helpful error for text type without length", async () => {
    const source = "base name (A)."
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.length).toBeGreaterThan(0)
      expect(result.left[0]?.message).toContain(
        "Text type (A) requires the maximum length",
      )
      expect(result.left[0]?.message).toContain("A<max_length>")
      expect(result.left[0]?.message).toContain("A255")
    }
  })

  it("should report helpful error for real type without digits", async () => {
    const source = "base price (R)."
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.length).toBeGreaterThan(0)
      expect(result.left[0]?.message).toContain(
        "Real type (R) requires digits before and after decimal point",
      )
      expect(result.left[0]?.message).toContain(
        "R<digits_before>,<digits_after>",
      )
      expect(result.left[0]?.message).toContain("R10,2")
    }
  })

  it("should report helpful error for real type with only first digit", async () => {
    const source = "base price (R10)."
    const result = await parseSourceExpectingErrors(source)

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.length).toBeGreaterThan(0)
      // Should get error about missing comma or second number
      expect(result.left.length).toBeGreaterThan(0)
    }
  })
})
