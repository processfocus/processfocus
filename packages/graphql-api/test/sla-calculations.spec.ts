import {
  calculateSlaTarget,
  calculateSlaWarning,
  slaToMs,
} from "../src/lib/rxdb/execution"
import { describe, expect, it } from "bun:test"

describe("slaToMs", () => {
  it("should convert minutes to milliseconds", () => {
    expect(slaToMs(30, "minutes")).toBe(30 * 60 * 1000) // 1,800,000 ms
  })

  it("should convert businessHours to milliseconds", () => {
    expect(slaToMs(2, "businessHours")).toBe(2 * 60 * 60 * 1000) // 7,200,000 ms
  })

  it("should convert businessDays to milliseconds (8 hours per day)", () => {
    expect(slaToMs(1, "businessDays")).toBe(8 * 60 * 60 * 1000) // 28,800,000 ms
  })

  it("should convert businessWeeks to milliseconds (5 days * 8 hours)", () => {
    expect(slaToMs(1, "businessWeeks")).toBe(5 * 8 * 60 * 60 * 1000) // 144,000,000 ms
  })

  it("should default to hours for unknown units", () => {
    expect(slaToMs(3, "unknownUnit")).toBe(3 * 60 * 60 * 1000) // 10,800,000 ms
  })
})

describe("calculateSlaTarget", () => {
  const startedAt = "2024-01-15T10:00:00.000Z"

  it("should return null when slaValue is null", () => {
    expect(calculateSlaTarget(startedAt, null, "businessHours")).toBeNull()
  })

  it("should return null when slaUnit is null", () => {
    expect(calculateSlaTarget(startedAt, 4, null)).toBeNull()
  })

  it("should return null when both are null", () => {
    expect(calculateSlaTarget(startedAt, null, null)).toBeNull()
  })

  it("should calculate target for businessHours", () => {
    // 4 business hours from 10:00 = 14:00
    const result = calculateSlaTarget(startedAt, 4, "businessHours")
    expect(result).toBe("2024-01-15T14:00:00.000Z")
  })

  it("should calculate target for businessDays", () => {
    // 1 business day (8 hours) from 10:00 = 18:00
    const result = calculateSlaTarget(startedAt, 1, "businessDays")
    expect(result).toBe("2024-01-15T18:00:00.000Z")
  })

  it("should calculate target for minutes", () => {
    // 90 minutes from 10:00 = 11:30
    const result = calculateSlaTarget(startedAt, 90, "minutes")
    expect(result).toBe("2024-01-15T11:30:00.000Z")
  })

  it("should calculate target for businessWeeks", () => {
    // 1 business week (40 hours) from Monday 10:00
    const result = calculateSlaTarget(startedAt, 1, "businessWeeks")
    // 40 hours = 1 day 16 hours, so Jan 15 10:00 + 40h = Jan 17 02:00
    expect(result).toBe("2024-01-17T02:00:00.000Z")
  })
})

describe("calculateSlaWarning", () => {
  const startedAt = "2024-01-15T10:00:00.000Z"

  describe("null handling", () => {
    it("should return null when slaValue is null", () => {
      expect(
        calculateSlaWarning(startedAt, null, "businessHours", 80),
      ).toBeNull()
    })

    it("should return null when slaUnit is null", () => {
      expect(calculateSlaWarning(startedAt, 4, null, 80)).toBeNull()
    })

    it("should return null when both value and unit are null", () => {
      expect(calculateSlaWarning(startedAt, null, null, 80)).toBeNull()
    })
  })

  describe("null warning threshold", () => {
    it("should return null when warningPercent is null", () => {
      // No warning threshold configured = no warning
      const result = calculateSlaWarning(startedAt, 4, "businessHours", null)
      expect(result).toBeNull()
    })

    it("should return null when all SLA fields set but no warning threshold", () => {
      // Even with valid SLA value/unit, null warning threshold means no warning
      const result = calculateSlaWarning(startedAt, 1, "businessDays", null)
      expect(result).toBeNull()
    })
  })

  describe("custom warning percentages", () => {
    it("should calculate warning at 50%", () => {
      // 4 hours SLA, 50% = 2 hours from 10:00 = 12:00
      const result = calculateSlaWarning(startedAt, 4, "businessHours", 50)
      expect(result).toBe("2024-01-15T12:00:00.000Z")
    })

    it("should calculate warning at 90%", () => {
      // 4 hours SLA, 90% = 3.6 hours = 3h 36m from 10:00 = 13:36
      const result = calculateSlaWarning(startedAt, 4, "businessHours", 90)
      expect(result).toBe("2024-01-15T13:36:00.000Z")
    })

    it("should calculate warning at 25%", () => {
      // 4 hours SLA, 25% = 1 hour from 10:00 = 11:00
      const result = calculateSlaWarning(startedAt, 4, "businessHours", 25)
      expect(result).toBe("2024-01-15T11:00:00.000Z")
    })
  })

  describe("edge cases", () => {
    it("should handle 0% warning threshold (immediate warning)", () => {
      // 0% = warning at start time
      const result = calculateSlaWarning(startedAt, 4, "businessHours", 0)
      expect(result).toBe(startedAt)
    })

    it("should handle 100% warning threshold (warning at deadline)", () => {
      // 100% = warning at same time as target
      const result = calculateSlaWarning(startedAt, 4, "businessHours", 100)
      expect(result).toBe("2024-01-15T14:00:00.000Z")
    })

    it("should handle percentage > 100% (warning after deadline)", () => {
      // 150% of 4 hours = 6 hours from 10:00 = 16:00
      const result = calculateSlaWarning(startedAt, 4, "businessHours", 150)
      expect(result).toBe("2024-01-15T16:00:00.000Z")
    })

    it("should handle very small SLA values", () => {
      // 1 minute SLA, 80% = 48 seconds
      const result = calculateSlaWarning(startedAt, 1, "minutes", 80)
      expect(result).toBe("2024-01-15T10:00:48.000Z")
    })

    it("should handle large SLA values", () => {
      // 4 business weeks, 80% = 3.2 weeks = 128 hours
      const result = calculateSlaWarning(startedAt, 4, "businessWeeks", 80)
      const expected = new Date(
        new Date(startedAt).getTime() + 4 * 5 * 8 * 60 * 60 * 1000 * 0.8,
      ).toISOString()
      expect(result).toBe(expected)
    })
  })

  describe("relationship between warning and target", () => {
    it("warning should always be before target at typical 80%", () => {
      const warning = calculateSlaWarning(startedAt, 4, "businessHours", 80)
      const target = calculateSlaTarget(startedAt, 4, "businessHours")

      expect(warning).not.toBeNull()
      expect(target).not.toBeNull()
      expect(new Date(warning!).getTime()).toBeLessThan(
        new Date(target!).getTime(),
      )
    })

    it("warning equals target at 100%", () => {
      const warning = calculateSlaWarning(startedAt, 4, "businessHours", 100)
      const target = calculateSlaTarget(startedAt, 4, "businessHours")

      expect(warning).toBe(target)
    })

    it("no warning when threshold is null, but target still calculated", () => {
      const warning = calculateSlaWarning(startedAt, 4, "businessHours", null)
      const target = calculateSlaTarget(startedAt, 4, "businessHours")

      expect(warning).toBeNull()
      expect(target).not.toBeNull()
    })
  })
})
