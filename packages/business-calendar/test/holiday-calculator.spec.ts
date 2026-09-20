import { DateTime, Effect } from "effect"
import {
  Friday,
  Monday,
  type Month,
  Thursday,
  easterRelativeHoliday,
  fixedHoliday,
  lastWeekdayHoliday,
  nthWeekdayHoliday,
} from "../src/index.js"
import { InvalidDateError, InvalidYearError } from "../src/lib/errors.js"
import {
  calculateEasterSunday,
  calculateHolidaysForYear,
  getLastWeekdayOfMonth,
  getNthWeekdayOfMonth,
} from "../src/lib/holiday-calculator.js"
import { describe, expect, it } from "bun:test"

describe("calculateEasterSunday", () => {
  it("should calculate Easter 2024 correctly", () => {
    const easter = Effect.runSync(calculateEasterSunday(2024))
    const parts = DateTime.toParts(easter)
    expect(parts.year).toBe(2024)
    expect(parts.month).toBe(3) // March
    expect(parts.day).toBe(31)
  })

  it("should calculate Easter 2025 correctly", () => {
    const easter = Effect.runSync(calculateEasterSunday(2025))
    const parts = DateTime.toParts(easter)
    expect(parts.year).toBe(2025)
    expect(parts.month).toBe(4) // April
    expect(parts.day).toBe(20)
  })

  it("should calculate Easter 2026 correctly", () => {
    const easter = Effect.runSync(calculateEasterSunday(2026))
    const parts = DateTime.toParts(easter)
    expect(parts.year).toBe(2026)
    expect(parts.month).toBe(4) // April
    expect(parts.day).toBe(5)
  })

  it("should fail for years before 1583 (pre-Gregorian)", () => {
    const result = Effect.runSyncExit(calculateEasterSunday(1500))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      const error = result.cause
      expect(error._tag).toBe("Fail")
      if (error._tag === "Fail") {
        expect(error.error).toBeInstanceOf(InvalidYearError)
        expect((error.error as InvalidYearError).year).toBe(1500)
      }
    }
  })

  it("should fail for non-integer years", () => {
    const result = Effect.runSyncExit(calculateEasterSunday(2024.5))
    expect(result._tag).toBe("Failure")
  })

  it("should fail for years beyond 9999", () => {
    const result = Effect.runSyncExit(calculateEasterSunday(10000))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      const error = result.cause
      expect(error._tag).toBe("Fail")
      if (error._tag === "Fail") {
        expect(error.error).toBeInstanceOf(InvalidYearError)
      }
    }
  })
})

describe("getNthWeekdayOfMonth", () => {
  it("should find the 3rd Monday of January 2024 (MLK Day)", () => {
    const date = Effect.runSync(
      getNthWeekdayOfMonth(2024, 1 as Month, Monday, 3),
    )
    expect(date).toBeDefined()
    const parts = DateTime.toParts(date!)
    expect(parts.year).toBe(2024)
    expect(parts.month).toBe(1)
    expect(parts.day).toBe(15)
    expect(parts.weekDay).toBe(1) // Monday
  })

  it("should find the 4th Thursday of November 2024 (Thanksgiving)", () => {
    const date = Effect.runSync(
      getNthWeekdayOfMonth(2024, 11 as Month, Thursday, 4),
    )
    expect(date).toBeDefined()
    const parts = DateTime.toParts(date!)
    expect(parts.year).toBe(2024)
    expect(parts.month).toBe(11)
    expect(parts.day).toBe(28)
    expect(parts.weekDay).toBe(4) // Thursday
  })

  it("should return undefined if the nth occurrence doesn't exist", () => {
    // 5th Monday of February 2024 doesn't exist
    const date = Effect.runSync(
      getNthWeekdayOfMonth(2024, 2 as Month, Monday, 5),
    )
    expect(date).toBeUndefined()
  })

  it("should fail for invalid years", () => {
    const result = Effect.runSyncExit(
      getNthWeekdayOfMonth(1500, 1 as Month, Monday, 3),
    )
    expect(result._tag).toBe("Failure")
  })
})

describe("getLastWeekdayOfMonth", () => {
  it("should find the last Monday of May 2024 (Memorial Day)", () => {
    const date = Effect.runSync(getLastWeekdayOfMonth(2024, 5 as Month, Monday))
    const parts = DateTime.toParts(date)
    expect(parts.year).toBe(2024)
    expect(parts.month).toBe(5)
    expect(parts.day).toBe(27)
    expect(parts.weekDay).toBe(1) // Monday
  })

  it("should find the last Friday of December 2024", () => {
    const date = Effect.runSync(
      getLastWeekdayOfMonth(2024, 12 as Month, Friday),
    )
    const parts = DateTime.toParts(date)
    expect(parts.year).toBe(2024)
    expect(parts.month).toBe(12)
    expect(parts.day).toBe(27)
    expect(parts.weekDay).toBe(5) // Friday
  })

  it("should fail for invalid years", () => {
    const result = Effect.runSyncExit(
      getLastWeekdayOfMonth(1500, 5 as Month, Monday),
    )
    expect(result._tag).toBe("Failure")
  })
})

describe("calculateHolidaysForYear", () => {
  it("should calculate fixed holidays", () => {
    const holidays = [
      fixedHoliday("Christmas", 12, 25),
      fixedHoliday("New Year", 1, 1),
    ]

    const instances = Effect.runSync(calculateHolidaysForYear(holidays, 2024))
    expect(instances).toHaveLength(2)

    // Sorted by date
    expect(instances[0]!.name).toBe("New Year")
    expect(instances[1]!.name).toBe("Christmas")

    const newYearParts = DateTime.toParts(instances[0]!.date)
    expect(newYearParts.month).toBe(1)
    expect(newYearParts.day).toBe(1)

    const christmasParts = DateTime.toParts(instances[1]!.date)
    expect(christmasParts.month).toBe(12)
    expect(christmasParts.day).toBe(25)
  })

  it("should calculate Easter-relative holidays", () => {
    const holidays = [
      easterRelativeHoliday("Good Friday", -2),
      easterRelativeHoliday("Easter Sunday", 0),
      easterRelativeHoliday("Easter Monday", 1),
    ]

    const instances = Effect.runSync(calculateHolidaysForYear(holidays, 2024))
    expect(instances).toHaveLength(3)

    // Easter 2024 is March 31
    const goodFridayParts = DateTime.toParts(instances[0]!.date)
    expect(goodFridayParts.month).toBe(3)
    expect(goodFridayParts.day).toBe(29)

    const easterParts = DateTime.toParts(instances[1]!.date)
    expect(easterParts.month).toBe(3)
    expect(easterParts.day).toBe(31)

    const easterMondayParts = DateTime.toParts(instances[2]!.date)
    expect(easterMondayParts.month).toBe(4)
    expect(easterMondayParts.day).toBe(1)
  })

  it("should calculate nth weekday holidays", () => {
    const holidays = [
      nthWeekdayHoliday("MLK Day", 1, 1, 3), // 3rd Monday of January
      nthWeekdayHoliday("Thanksgiving", 11, 4, 4), // 4th Thursday of November
    ]

    const instances = Effect.runSync(calculateHolidaysForYear(holidays, 2024))
    expect(instances).toHaveLength(2)

    const mlkParts = DateTime.toParts(instances[0]!.date)
    expect(mlkParts.month).toBe(1)
    expect(mlkParts.day).toBe(15)

    const thanksgivingParts = DateTime.toParts(instances[1]!.date)
    expect(thanksgivingParts.month).toBe(11)
    expect(thanksgivingParts.day).toBe(28)
  })

  it("should calculate last weekday holidays", () => {
    const holidays = [lastWeekdayHoliday("Memorial Day", 5, 1)] // Last Monday of May

    const instances = Effect.runSync(calculateHolidaysForYear(holidays, 2024))
    expect(instances).toHaveLength(1)

    const parts = DateTime.toParts(instances[0]!.date)
    expect(parts.month).toBe(5)
    expect(parts.day).toBe(27)
  })

  it("should handle mixed holiday types", () => {
    const holidays = [
      fixedHoliday("New Year", 1, 1),
      easterRelativeHoliday("Good Friday", -2),
      nthWeekdayHoliday("Labor Day", 9, 1, 1), // 1st Monday of September
      lastWeekdayHoliday("Memorial Day", 5, 1),
    ]

    const instances = Effect.runSync(calculateHolidaysForYear(holidays, 2024))
    expect(instances).toHaveLength(4)

    // Should be sorted by date
    expect(instances[0]!.name).toBe("New Year")
    expect(instances[1]!.name).toBe("Good Friday")
    expect(instances[2]!.name).toBe("Memorial Day")
    expect(instances[3]!.name).toBe("Labor Day")
  })

  it("should fail for invalid fixed holiday dates (Feb 30)", () => {
    const holidays = [fixedHoliday("Invalid", 2, 30)]

    const result = Effect.runSyncExit(calculateHolidaysForYear(holidays, 2024))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      const error = result.cause
      expect(error._tag).toBe("Fail")
      if (error._tag === "Fail") {
        expect(error.error).toBeInstanceOf(InvalidDateError)
        expect((error.error as InvalidDateError).message).toContain("Month 2")
        expect((error.error as InvalidDateError).day).toBe(30)
      }
    }
  })

  it("should fail for invalid year", () => {
    const holidays = [fixedHoliday("Christmas", 12, 25)]

    const result = Effect.runSyncExit(calculateHolidaysForYear(holidays, 1500))
    expect(result._tag).toBe("Failure")
  })
})

describe("helper function validation", () => {
  it("should throw for invalid month in fixedHoliday", () => {
    expect(() => fixedHoliday("Invalid", 13, 1)).toThrow()
  })

  it("should throw for invalid day in fixedHoliday", () => {
    expect(() => fixedHoliday("Invalid", 1, 32)).toThrow()
  })

  it("should throw for invalid month in nthWeekdayHoliday", () => {
    expect(() => nthWeekdayHoliday("Invalid", 0, 1, 1)).toThrow()
  })

  it("should throw for invalid weekday in nthWeekdayHoliday", () => {
    expect(() => nthWeekdayHoliday("Invalid", 1, 7, 1)).toThrow()
  })

  it("should throw for invalid nth in nthWeekdayHoliday", () => {
    expect(() => nthWeekdayHoliday("Invalid", 1, 1, 6)).toThrow()
  })

  it("should throw for invalid weekday in lastWeekdayHoliday", () => {
    expect(() => lastWeekdayHoliday("Invalid", 1, -1)).toThrow()
  })
})
