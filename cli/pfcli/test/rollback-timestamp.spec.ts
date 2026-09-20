import { normalizeRollbackTimestamp } from "../src/utils/rollback-timestamp"
import { describe, expect, it } from "bun:test"

describe("normalizeRollbackTimestamp", () => {
  it("preserves timestamps that already include UTC", () => {
    expect(normalizeRollbackTimestamp("2026-04-01T00:00:00Z")).toBe(
      "2026-04-01T00:00:00Z",
    )
  })

  it("converts offset timestamps to equivalent UTC", () => {
    expect(normalizeRollbackTimestamp("2026-04-01T00:00:00+13:00")).toBe(
      "2026-03-31T11:00:00Z",
    )
  })

  it("uses the current process timezone for local datetimes", () => {
    const originalTimezone = process.env.TZ
    process.env.TZ = "Pacific/Auckland"

    try {
      expect(normalizeRollbackTimestamp("2026-01-16T18:00:00")).toBe(
        "2026-01-16T05:00:00Z",
      )
      expect(normalizeRollbackTimestamp("2026-04-16T18:00:00")).toBe(
        "2026-04-16T06:00:00Z",
      )
      expect(normalizeRollbackTimestamp("2026-06-16T18:00:00")).toBe(
        "2026-06-16T06:00:00Z",
      )
    } finally {
      if (originalTimezone === undefined) {
        delete process.env.TZ
      } else {
        process.env.TZ = originalTimezone
      }
    }
  })

  it("leaves non-ISO inputs unchanged so validation can reject them", () => {
    expect(normalizeRollbackTimestamp("yesterday")).toBe("yesterday")
  })
})
