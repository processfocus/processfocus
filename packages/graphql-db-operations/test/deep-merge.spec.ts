import { describe, expect, it } from "vitest"
import { deepMerge } from "../src/lib/deep-merge"

describe("deepMerge", () => {
  describe("basic flat objects", () => {
    it("should merge two flat objects", () => {
      const target = { a: 1, b: 2 }
      const source = { c: 3 }
      const result = deepMerge(target, source)
      expect(result).toEqual({ a: 1, b: 2, c: 3 })
    })

    it("should overwrite existing keys with source values", () => {
      const target = { a: 1, b: 2 }
      const source = { b: 3 }
      const result = deepMerge(target, source)
      expect(result).toEqual({ a: 1, b: 3 })
    })

    it("should not mutate the original objects", () => {
      const target = { a: 1 }
      const source = { b: 2 }
      const result = deepMerge(target, source)
      expect(target).toEqual({ a: 1 })
      expect(source).toEqual({ b: 2 })
      expect(result).toEqual({ a: 1, b: 2 })
    })
  })

  describe("nested object merging (the PostgreSQL bug fix)", () => {
    it("should preserve nested properties when merging", () => {
      // This is the exact scenario that was broken with PostgreSQL || operator
      const target = { user: { name: "John", age: 30 }, status: "active" }
      const source = { user: { age: 31 } }
      const result = deepMerge(target, source)
      expect(result).toEqual({
        user: { name: "John", age: 31 },
        status: "active",
      })
    })

    it("should handle deeply nested objects (3+ levels)", () => {
      const target = { a: { b: { c: 1, d: 2 } } }
      const source = { a: { b: { d: 3, e: 4 } } }
      const result = deepMerge(target, source)
      expect(result).toEqual({ a: { b: { c: 1, d: 3, e: 4 } } })
    })

    it("should handle multiple nested paths", () => {
      const target = {
        user: { name: "John", preferences: { theme: "dark", fontSize: 14 } },
        metadata: { created: "2024-01-01" },
      }
      const source = {
        user: { preferences: { fontSize: 16 } },
        metadata: { updated: "2024-01-02" },
      }
      const result = deepMerge(target, source)
      expect(result).toEqual({
        user: { name: "John", preferences: { theme: "dark", fontSize: 16 } },
        metadata: { created: "2024-01-01", updated: "2024-01-02" },
      })
    })

    it("should add new nested keys", () => {
      const target = { user: { name: "John" } }
      const source = { user: { email: "john@example.com" } }
      const result = deepMerge(target, source)
      expect(result).toEqual({
        user: { name: "John", email: "john@example.com" },
      })
    })
  })

  describe("array handling", () => {
    it("should replace arrays, not merge them", () => {
      const target = { items: [1, 2, 3] }
      const source = { items: [4, 5] }
      const result = deepMerge(target, source)
      expect(result).toEqual({ items: [4, 5] })
    })

    it("should replace array with empty array", () => {
      const target = { items: [1, 2, 3] }
      const source = { items: [] }
      const result = deepMerge(target, source)
      expect(result).toEqual({ items: [] })
    })

    it("should replace object with array", () => {
      const target = { data: { nested: true } }
      const source = { data: [1, 2, 3] }
      const result = deepMerge(target, source)
      expect(result).toEqual({ data: [1, 2, 3] })
    })

    it("should replace array with object", () => {
      const target = { data: [1, 2, 3] }
      const source = { data: { nested: true } }
      const result = deepMerge(target, source)
      expect(result).toEqual({ data: { nested: true } })
    })

    it("should handle arrays of objects (replace, not merge)", () => {
      const target = { users: [{ name: "John" }, { name: "Jane" }] }
      const source = { users: [{ name: "Bob" }] }
      const result = deepMerge(target, source)
      expect(result).toEqual({ users: [{ name: "Bob" }] })
    })
  })

  describe("null and undefined values", () => {
    it("should delete keys with null", () => {
      const target = { a: 1, b: { c: 2 } }
      const source = { a: null, b: null }
      const result = deepMerge(target, source)
      expect(result).toEqual({})
    })

    it("should delete nested keys with null", () => {
      const target = { a: 1, b: { c: 2, d: 3 } }
      const source = { b: { c: null } }
      const result = deepMerge(target, source)
      expect(result).toEqual({ a: 1, b: { d: 3 } })
    })

    it("should ignore undefined values in source", () => {
      const target = { a: 1, b: 2 }
      const source = { a: undefined, c: 3 }
      const result = deepMerge(target, source)
      expect(result).toEqual({ a: 1, b: 2, c: 3 })
    })

    it("should handle null in target being overwritten by object", () => {
      const target = { user: null }
      const source = { user: { name: "John" } }
      const result = deepMerge(target, source)
      expect(result).toEqual({ user: { name: "John" } })
    })

    it("should not deep merge into null", () => {
      const target = { user: null }
      const source = { user: { name: "John" } }
      const result = deepMerge(target, source)
      // Should replace null with the object, not try to merge into null
      expect(result["user"]).toEqual({ name: "John" })
    })
  })

  describe("edge cases", () => {
    it("should handle empty target", () => {
      const target = {}
      const source = { a: 1, b: { c: 2 } }
      const result = deepMerge(target, source)
      expect(result).toEqual({ a: 1, b: { c: 2 } })
    })

    it("should handle empty source", () => {
      const target = { a: 1, b: { c: 2 } }
      const source = {}
      const result = deepMerge(target, source)
      expect(result).toEqual({ a: 1, b: { c: 2 } })
    })

    it("should handle both empty", () => {
      const result = deepMerge({}, {})
      expect(result).toEqual({})
    })

    it("should handle primitive types", () => {
      const target = { str: "hello", num: 42, bool: true }
      const source = { str: "world", num: 100, bool: false }
      const result = deepMerge(target, source)
      expect(result).toEqual({ str: "world", num: 100, bool: false })
    })

    it("should handle Date objects (replace, not merge)", () => {
      const date1 = new Date("2024-01-01")
      const date2 = new Date("2024-12-31")
      const target = { created: date1 }
      const source = { created: date2 }
      const result = deepMerge(target, source)
      expect(result["created"]).toBe(date2)
    })

    it("should handle RegExp objects (replace, not merge)", () => {
      const regex1 = /abc/
      const regex2 = /xyz/g
      const target = { pattern: regex1 }
      const source = { pattern: regex2 }
      const result = deepMerge(target, source)
      expect(result["pattern"]).toBe(regex2)
    })

    it("should handle mixed types at same key", () => {
      const target = { value: "string" }
      const source = { value: 42 }
      const result = deepMerge(target, source)
      expect(result).toEqual({ value: 42 })
    })
  })

  describe("real-world process state scenarios", () => {
    it("should merge form submission data into existing state", () => {
      // Simulates completing a form step that adds new data
      const existingState = {
        requestor: { name: "Alice", department: "Engineering" },
        amount: 1000,
        status: "pending",
      }
      const formSubmission = {
        approver: { name: "Bob", decision: "approved" },
        status: "approved",
      }
      const result = deepMerge(existingState, formSubmission)
      expect(result).toEqual({
        requestor: { name: "Alice", department: "Engineering" },
        amount: 1000,
        approver: { name: "Bob", decision: "approved" },
        status: "approved",
      })
    })

    it("should update nested form fields while preserving others", () => {
      // Simulates editing a subset of form fields
      const existingState = {
        expense: {
          vendor: "Acme Corp",
          amount: 500,
          category: "Software",
          notes: "Annual license",
        },
      }
      const formUpdate = {
        expense: {
          amount: 600,
          notes: "Annual license (updated price)",
        },
      }
      const result = deepMerge(existingState, formUpdate)
      expect(result).toEqual({
        expense: {
          vendor: "Acme Corp",
          amount: 600,
          category: "Software",
          notes: "Annual license (updated price)",
        },
      })
    })

    it("should handle multi-step form completion", () => {
      // Step 1: Initial submission
      let state: Record<string, unknown> = {}
      state = deepMerge(state, {
        step1: { name: "Project Alpha", budget: 10000 },
      })

      // Step 2: Add team details
      state = deepMerge(state, {
        step2: { teamLead: "Alice", teamSize: 5 },
      })

      // Step 3: Update step 1 and add step 3
      state = deepMerge(state, {
        step1: { budget: 15000 }, // Update budget
        step3: { timeline: "Q1 2025" },
      })

      expect(state).toEqual({
        step1: { name: "Project Alpha", budget: 15000 },
        step2: { teamLead: "Alice", teamSize: 5 },
        step3: { timeline: "Q1 2025" },
      })
    })
  })
})
