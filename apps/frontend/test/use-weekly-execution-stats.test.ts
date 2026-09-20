import { describe, expect, test } from "vitest"
import { getWeekStart } from "../hooks/use-weekly-execution-stats"

describe("getWeekStart with Monday start (startDayOfWeek: 1)", () => {
  test("returns Monday 00:00:00 for a Monday input", () => {
    // Monday, January 20, 2025 at 14:30:00
    const monday = new Date(2025, 0, 20, 14, 30, 0)
    const result = getWeekStart(monday, 1)

    expect(result.getDay()).toBe(1) // Monday
    expect(result.getFullYear()).toBe(2025)
    expect(result.getMonth()).toBe(0) // January
    expect(result.getDate()).toBe(20)
    expect(result.getHours()).toBe(0)
    expect(result.getMinutes()).toBe(0)
    expect(result.getSeconds()).toBe(0)
  })

  test("returns previous Monday for a Wednesday input", () => {
    // Wednesday, January 22, 2025
    const wednesday = new Date(2025, 0, 22, 10, 0, 0)
    const result = getWeekStart(wednesday, 1)

    expect(result.getDay()).toBe(1) // Monday
    expect(result.getDate()).toBe(20) // Monday the 20th
  })

  test("returns previous Monday for a Sunday input", () => {
    // Sunday, January 26, 2025
    const sunday = new Date(2025, 0, 26, 23, 59, 59)
    const result = getWeekStart(sunday, 1)

    expect(result.getDay()).toBe(1) // Monday
    expect(result.getDate()).toBe(20) // Monday the 20th (6 days back)
  })

  test("handles Sunday edge case correctly (goes back 6 days)", () => {
    // Sunday, January 19, 2025
    const sunday = new Date(2025, 0, 19, 12, 0, 0)
    const result = getWeekStart(sunday, 1)

    expect(result.getDay()).toBe(1) // Monday
    expect(result.getDate()).toBe(13) // Monday the 13th
  })

  test("returns previous Monday for a Saturday input", () => {
    // Saturday, January 25, 2025
    const saturday = new Date(2025, 0, 25, 18, 0, 0)
    const result = getWeekStart(saturday, 1)

    expect(result.getDay()).toBe(1) // Monday
    expect(result.getDate()).toBe(20) // Monday the 20th (5 days back)
  })

  test("handles month boundary (week spans two months)", () => {
    // Wednesday, February 5, 2025
    const wednesday = new Date(2025, 1, 5, 10, 0, 0)
    const result = getWeekStart(wednesday, 1)

    expect(result.getDay()).toBe(1) // Monday
    expect(result.getMonth()).toBe(1) // February
    expect(result.getDate()).toBe(3) // Monday the 3rd
  })

  test("handles month boundary when Monday is in previous month", () => {
    // Thursday, January 2, 2025
    const thursday = new Date(2025, 0, 2, 10, 0, 0)
    const result = getWeekStart(thursday, 1)

    expect(result.getDay()).toBe(1) // Monday
    expect(result.getMonth()).toBe(11) // December (previous year)
    expect(result.getFullYear()).toBe(2024)
    expect(result.getDate()).toBe(30) // Monday the 30th
  })

  test("handles year boundary", () => {
    // Wednesday, January 1, 2025
    const newYearsDay = new Date(2025, 0, 1, 0, 0, 0)
    const result = getWeekStart(newYearsDay, 1)

    expect(result.getDay()).toBe(1) // Monday
    expect(result.getMonth()).toBe(11) // December
    expect(result.getFullYear()).toBe(2024)
    expect(result.getDate()).toBe(30)
  })

  test("does not mutate the input date", () => {
    const original = new Date(2025, 0, 22, 14, 30, 0)
    const originalTime = original.getTime()

    getWeekStart(original, 1)

    expect(original.getTime()).toBe(originalTime)
  })

  test("returns consistent results for all days of the same week", () => {
    // Week of January 20-26, 2025 (Monday-Sunday)
    const monday = new Date(2025, 0, 20, 9, 0, 0)
    const tuesday = new Date(2025, 0, 21, 10, 0, 0)
    const wednesday = new Date(2025, 0, 22, 11, 0, 0)
    const thursday = new Date(2025, 0, 23, 12, 0, 0)
    const friday = new Date(2025, 0, 24, 13, 0, 0)
    const saturday = new Date(2025, 0, 25, 14, 0, 0)
    const sunday = new Date(2025, 0, 26, 15, 0, 0)

    const expectedStart = new Date(2025, 0, 20, 0, 0, 0, 0).getTime()

    expect(getWeekStart(monday, 1).getTime()).toBe(expectedStart)
    expect(getWeekStart(tuesday, 1).getTime()).toBe(expectedStart)
    expect(getWeekStart(wednesday, 1).getTime()).toBe(expectedStart)
    expect(getWeekStart(thursday, 1).getTime()).toBe(expectedStart)
    expect(getWeekStart(friday, 1).getTime()).toBe(expectedStart)
    expect(getWeekStart(saturday, 1).getTime()).toBe(expectedStart)
    expect(getWeekStart(sunday, 1).getTime()).toBe(expectedStart)
  })
})

describe("getWeekStart with configurable start day", () => {
  describe("Sunday start (startDayOfWeek: 0, default)", () => {
    test("returns same Sunday for a Sunday input", () => {
      // Sunday, January 19, 2025
      const sunday = new Date(2025, 0, 19, 12, 0, 0)
      const result = getWeekStart(sunday, 0)

      expect(result.getDay()).toBe(0) // Sunday
      expect(result.getDate()).toBe(19) // Same Sunday
      expect(result.getHours()).toBe(0)
    })

    test("returns previous Sunday for a Monday input", () => {
      // Monday, January 20, 2025
      const monday = new Date(2025, 0, 20, 14, 30, 0)
      const result = getWeekStart(monday, 0)

      expect(result.getDay()).toBe(0) // Sunday
      expect(result.getDate()).toBe(19) // Sunday the 19th
    })

    test("returns previous Sunday for a Saturday input", () => {
      // Saturday, January 25, 2025
      const saturday = new Date(2025, 0, 25, 18, 0, 0)
      const result = getWeekStart(saturday, 0)

      expect(result.getDay()).toBe(0) // Sunday
      expect(result.getDate()).toBe(19) // Sunday the 19th (6 days back)
    })

    test("default parameter is Sunday (0)", () => {
      // Monday, January 20, 2025
      const monday = new Date(2025, 0, 20, 14, 30, 0)
      const result = getWeekStart(monday) // No second parameter

      expect(result.getDay()).toBe(0) // Sunday
      expect(result.getDate()).toBe(19) // Sunday the 19th
    })

    test("returns consistent results for all days of the same week", () => {
      // Week of January 19-25, 2025 (Sunday-Saturday with Sunday start)
      const sunday = new Date(2025, 0, 19, 9, 0, 0)
      const monday = new Date(2025, 0, 20, 10, 0, 0)
      const tuesday = new Date(2025, 0, 21, 11, 0, 0)
      const wednesday = new Date(2025, 0, 22, 12, 0, 0)
      const thursday = new Date(2025, 0, 23, 13, 0, 0)
      const friday = new Date(2025, 0, 24, 14, 0, 0)
      const saturday = new Date(2025, 0, 25, 15, 0, 0)

      const expectedStart = new Date(2025, 0, 19, 0, 0, 0, 0).getTime()

      expect(getWeekStart(sunday, 0).getTime()).toBe(expectedStart)
      expect(getWeekStart(monday, 0).getTime()).toBe(expectedStart)
      expect(getWeekStart(tuesday, 0).getTime()).toBe(expectedStart)
      expect(getWeekStart(wednesday, 0).getTime()).toBe(expectedStart)
      expect(getWeekStart(thursday, 0).getTime()).toBe(expectedStart)
      expect(getWeekStart(friday, 0).getTime()).toBe(expectedStart)
      expect(getWeekStart(saturday, 0).getTime()).toBe(expectedStart)
    })
  })

  describe("Saturday start (startDayOfWeek: 6)", () => {
    test("returns same Saturday for a Saturday input", () => {
      // Saturday, January 25, 2025
      const saturday = new Date(2025, 0, 25, 18, 0, 0)
      const result = getWeekStart(saturday, 6)

      expect(result.getDay()).toBe(6) // Saturday
      expect(result.getDate()).toBe(25) // Same Saturday
      expect(result.getHours()).toBe(0)
    })

    test("returns previous Saturday for a Sunday input", () => {
      // Sunday, January 26, 2025
      const sunday = new Date(2025, 0, 26, 12, 0, 0)
      const result = getWeekStart(sunday, 6)

      expect(result.getDay()).toBe(6) // Saturday
      expect(result.getDate()).toBe(25) // Saturday the 25th
    })

    test("returns previous Saturday for a Friday input", () => {
      // Friday, January 31, 2025
      const friday = new Date(2025, 0, 31, 14, 0, 0)
      const result = getWeekStart(friday, 6)

      expect(result.getDay()).toBe(6) // Saturday
      expect(result.getDate()).toBe(25) // Saturday the 25th (6 days back)
    })

    test("returns consistent results for all days of the same week", () => {
      // Week of January 25-31, 2025 (Saturday-Friday with Saturday start)
      const saturday = new Date(2025, 0, 25, 9, 0, 0)
      const sunday = new Date(2025, 0, 26, 10, 0, 0)
      const monday = new Date(2025, 0, 27, 11, 0, 0)
      const tuesday = new Date(2025, 0, 28, 12, 0, 0)
      const wednesday = new Date(2025, 0, 29, 13, 0, 0)
      const thursday = new Date(2025, 0, 30, 14, 0, 0)
      const friday = new Date(2025, 0, 31, 15, 0, 0)

      const expectedStart = new Date(2025, 0, 25, 0, 0, 0, 0).getTime()

      expect(getWeekStart(saturday, 6).getTime()).toBe(expectedStart)
      expect(getWeekStart(sunday, 6).getTime()).toBe(expectedStart)
      expect(getWeekStart(monday, 6).getTime()).toBe(expectedStart)
      expect(getWeekStart(tuesday, 6).getTime()).toBe(expectedStart)
      expect(getWeekStart(wednesday, 6).getTime()).toBe(expectedStart)
      expect(getWeekStart(thursday, 6).getTime()).toBe(expectedStart)
      expect(getWeekStart(friday, 6).getTime()).toBe(expectedStart)
    })
  })

  describe("Wednesday start (startDayOfWeek: 3)", () => {
    test("returns same Wednesday for a Wednesday input", () => {
      // Wednesday, January 22, 2025
      const wednesday = new Date(2025, 0, 22, 11, 0, 0)
      const result = getWeekStart(wednesday, 3)

      expect(result.getDay()).toBe(3) // Wednesday
      expect(result.getDate()).toBe(22) // Same Wednesday
    })

    test("returns previous Wednesday for a Tuesday input", () => {
      // Tuesday, January 28, 2025
      const tuesday = new Date(2025, 0, 28, 10, 0, 0)
      const result = getWeekStart(tuesday, 3)

      expect(result.getDay()).toBe(3) // Wednesday
      expect(result.getDate()).toBe(22) // Wednesday the 22nd (6 days back)
    })

    test("returns consistent results for all days of the same week", () => {
      // Week of January 22-28, 2025 (Wednesday-Tuesday with Wednesday start)
      const wednesday = new Date(2025, 0, 22, 9, 0, 0)
      const thursday = new Date(2025, 0, 23, 10, 0, 0)
      const friday = new Date(2025, 0, 24, 11, 0, 0)
      const saturday = new Date(2025, 0, 25, 12, 0, 0)
      const sunday = new Date(2025, 0, 26, 13, 0, 0)
      const monday = new Date(2025, 0, 27, 14, 0, 0)
      const tuesday = new Date(2025, 0, 28, 15, 0, 0)

      const expectedStart = new Date(2025, 0, 22, 0, 0, 0, 0).getTime()

      expect(getWeekStart(wednesday, 3).getTime()).toBe(expectedStart)
      expect(getWeekStart(thursday, 3).getTime()).toBe(expectedStart)
      expect(getWeekStart(friday, 3).getTime()).toBe(expectedStart)
      expect(getWeekStart(saturday, 3).getTime()).toBe(expectedStart)
      expect(getWeekStart(sunday, 3).getTime()).toBe(expectedStart)
      expect(getWeekStart(monday, 3).getTime()).toBe(expectedStart)
      expect(getWeekStart(tuesday, 3).getTime()).toBe(expectedStart)
    })
  })
})
