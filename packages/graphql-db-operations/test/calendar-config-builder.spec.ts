import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type { OrgUnitCalendarData } from "../src/lib/business-calendar-queries"
import {
  buildCalendarConfig,
  hasCalendarConfigured,
  isValidDayOfWeek,
} from "../src/lib/calendar-config-builder"

describe("calendar-config-builder", () => {
  describe("isValidDayOfWeek", () => {
    it("should accept valid days 0-6", () => {
      expect(isValidDayOfWeek(0)).toBe(true)
      expect(isValidDayOfWeek(1)).toBe(true)
      expect(isValidDayOfWeek(6)).toBe(true)
    })

    it("should reject invalid day numbers", () => {
      expect(isValidDayOfWeek(-1)).toBe(false)
      expect(isValidDayOfWeek(7)).toBe(false)
      expect(isValidDayOfWeek(100)).toBe(false)
    })

    it("should reject non-integers", () => {
      expect(isValidDayOfWeek(1.5)).toBe(false)
      expect(isValidDayOfWeek(NaN)).toBe(false)
    })
  })

  describe("hasCalendarConfigured", () => {
    it("should return true when weekly schedule has entries", () => {
      const data: OrgUnitCalendarData = {
        orgUnitId: "org-1",
        timezone: "UTC",
        weeklySchedule: [
          {
            orgUnitId: "org-1",
            dayOfWeek: 1,
            timeRanges: [
              { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
            ],
          },
        ],
        dateExceptions: [],
        holidays: [],
        periods: [],
      }
      expect(hasCalendarConfigured(data)).toBe(true)
    })

    it("should return false when weekly schedule is empty", () => {
      const data: OrgUnitCalendarData = {
        orgUnitId: "org-1",
        timezone: "UTC",
        weeklySchedule: [],
        dateExceptions: [],
        holidays: [],
        periods: [],
      }
      expect(hasCalendarConfigured(data)).toBe(false)
    })
  })

  describe("buildCalendarConfig", () => {
    it("should build config from valid calendar data", async () => {
      const data: OrgUnitCalendarData = {
        orgUnitId: "org-1",
        timezone: "Europe/Amsterdam",
        weeklySchedule: [
          {
            orgUnitId: "org-1",
            dayOfWeek: 1,
            timeRanges: [
              { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
            ],
          },
          {
            orgUnitId: "org-1",
            dayOfWeek: 2,
            timeRanges: [
              { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
            ],
          },
        ],
        dateExceptions: [],
        holidays: [],
        periods: [],
      }

      const result = await Effect.runPromise(buildCalendarConfig(data))

      expect(result.timezone).toBe("Europe/Amsterdam")
      expect(result.weeklySchedule).toHaveLength(2)
      expect(result.weeklySchedule[0]?.day).toBe(1)
      expect(result.weeklySchedule[0]?.ranges[0]?.open).toEqual({
        hour: 9,
        minute: 0,
      })
      // Days 0, 3, 4, 5, 6 should be non-working days
      expect(result.nonWorkingDays).toHaveLength(5)
      // Cast to readonly number[] for comparison since DayOfWeek is a branded type
      const nonWorkingDaysAsNumbers = result.nonWorkingDays as readonly number[]
      expect(nonWorkingDaysAsNumbers).toContain(0) // Sunday
      expect(nonWorkingDaysAsNumbers).toContain(6) // Saturday
    })

    it("should fail with invalid day of week", async () => {
      const data: OrgUnitCalendarData = {
        orgUnitId: "org-1",
        timezone: "UTC",
        weeklySchedule: [
          {
            orgUnitId: "org-1",
            dayOfWeek: 7 as 0, // Invalid - cast to bypass TS
            timeRanges: [
              { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
            ],
          },
        ],
        dateExceptions: [],
        holidays: [],
        periods: [],
      }

      const result = await Effect.runPromiseExit(buildCalendarConfig(data))

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        const error = result.cause
        // Check it's an InvalidCalendarDataError
        expect(error._tag).toBe("Fail")
      }
    })

    it("should fail with invalid exception date", async () => {
      const data: OrgUnitCalendarData = {
        orgUnitId: "org-1",
        timezone: "UTC",
        weeklySchedule: [
          {
            orgUnitId: "org-1",
            dayOfWeek: 1,
            timeRanges: [
              { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
            ],
          },
        ],
        dateExceptions: [
          {
            orgUnitId: "org-1",
            // NaN is an invalid epoch ms - will fail DateTime.make
            exceptionDate: NaN,
            exceptionSlots: [],
            exceptionNote: "Test",
          },
        ],
        holidays: [],
        periods: [],
      }

      const result = await Effect.runPromiseExit(buildCalendarConfig(data))

      expect(result._tag).toBe("Failure")
    })

    it("should build config with date exceptions", async () => {
      // 2024-12-25 00:00:00 UTC as epoch ms
      const christmasEpochMs = Date.UTC(2024, 11, 25)

      const data: OrgUnitCalendarData = {
        orgUnitId: "org-1",
        timezone: "UTC",
        weeklySchedule: [
          {
            orgUnitId: "org-1",
            dayOfWeek: 1,
            timeRanges: [
              { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
            ],
          },
        ],
        dateExceptions: [
          {
            orgUnitId: "org-1",
            exceptionDate: christmasEpochMs,
            exceptionSlots: [],
            exceptionNote: "Christmas",
          },
        ],
        holidays: [],
        periods: [],
      }

      const result = await Effect.runPromise(buildCalendarConfig(data))

      expect(result.exceptions).toHaveLength(1)
      expect(result.exceptions[0]?.note).toBe("Christmas")
    })

    it("should build config with holidays", async () => {
      const data: OrgUnitCalendarData = {
        orgUnitId: "org-1",
        timezone: "UTC",
        weeklySchedule: [
          {
            orgUnitId: "org-1",
            dayOfWeek: 1,
            timeRanges: [
              { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
            ],
          },
        ],
        dateExceptions: [],
        holidays: [
          {
            orgUnitId: "org-1",
            holidayTitle: "Christmas",
            holidayRule: { type: "fixed", month: 12, day: 25 },
          },
        ],
        periods: [],
      }

      const result = await Effect.runPromise(buildCalendarConfig(data))

      expect(result.holidays).toHaveLength(1)
    })

    it("should build config with periods", async () => {
      // 2024-07-01 and 2024-07-31 as epoch ms
      const julyStartMs = Date.UTC(2024, 6, 1)
      const julyEndMs = Date.UTC(2024, 6, 31)

      const data: OrgUnitCalendarData = {
        orgUnitId: "org-1",
        timezone: "UTC",
        weeklySchedule: [
          {
            orgUnitId: "org-1",
            dayOfWeek: 1,
            timeRanges: [
              { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
            ],
          },
        ],
        dateExceptions: [],
        holidays: [],
        periods: [
          {
            orgUnitId: "org-1",
            periodKind: "vacation",
            periodTitle: "Summer Break",
            periodStart: julyStartMs,
            periodEnd: julyEndMs,
            periodActive: true,
            periodSchedule: undefined,
          },
        ],
      }

      const result = await Effect.runPromise(buildCalendarConfig(data))

      expect(result.periods).toHaveLength(1)
      expect(result.periods[0]?.name).toBe("Summer Break")
      expect(result.periods[0]?.type).toBe("vacation")
      expect(result.periods[0]?.isActive).toBe(true)
    })

    it("should fail with invalid period start date", async () => {
      const data: OrgUnitCalendarData = {
        orgUnitId: "org-1",
        timezone: "UTC",
        weeklySchedule: [],
        dateExceptions: [],
        holidays: [],
        periods: [
          {
            orgUnitId: "org-1",
            periodKind: "vacation",
            periodTitle: "Bad Period",
            periodStart: NaN, // Invalid
            periodEnd: Date.UTC(2024, 6, 31),
            periodActive: true,
            periodSchedule: undefined,
          },
        ],
      }

      const result = await Effect.runPromiseExit(buildCalendarConfig(data))

      expect(result._tag).toBe("Failure")
    })

    it("should fail with invalid period end date", async () => {
      const data: OrgUnitCalendarData = {
        orgUnitId: "org-1",
        timezone: "UTC",
        weeklySchedule: [],
        dateExceptions: [],
        holidays: [],
        periods: [
          {
            orgUnitId: "org-1",
            periodKind: "vacation",
            periodTitle: "Bad Period",
            periodStart: Date.UTC(2024, 6, 1),
            periodEnd: NaN, // Invalid
            periodActive: true,
            periodSchedule: undefined,
          },
        ],
      }

      const result = await Effect.runPromiseExit(buildCalendarConfig(data))

      expect(result._tag).toBe("Failure")
    })

    it("should handle periods with custom weekly schedule", async () => {
      const julyStartMs = Date.UTC(2024, 6, 1)
      const augustEndMs = Date.UTC(2024, 7, 31)

      const data: OrgUnitCalendarData = {
        orgUnitId: "org-1",
        timezone: "UTC",
        weeklySchedule: [
          {
            orgUnitId: "org-1",
            dayOfWeek: 1,
            timeRanges: [
              { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
            ],
          },
        ],
        dateExceptions: [],
        holidays: [],
        periods: [
          {
            orgUnitId: "org-1",
            periodKind: "reduced",
            periodTitle: "Summer Hours",
            periodStart: julyStartMs,
            periodEnd: augustEndMs,
            periodActive: true,
            periodSchedule: [
              {
                day: 1,
                ranges: [
                  {
                    open: { hour: 9, minute: 0 },
                    close: { hour: 14, minute: 0 },
                  },
                ],
              },
            ],
          },
        ],
      }

      const result = await Effect.runPromise(buildCalendarConfig(data))

      expect(result.periods).toHaveLength(1)
      expect(result.periods[0]?.weeklySchedule).toBeDefined()
      expect(result.periods[0]?.weeklySchedule).toHaveLength(1)
    })

    it("should filter out null holidays", async () => {
      const data: OrgUnitCalendarData = {
        orgUnitId: "org-1",
        timezone: "UTC",
        weeklySchedule: [],
        dateExceptions: [],
        holidays: [
          {
            orgUnitId: "org-1",
            holidayTitle: "Null Holiday",
            holidayRule: null,
          },
          {
            orgUnitId: "org-1",
            holidayTitle: "Christmas",
            holidayRule: { type: "fixed", month: 12, day: 25 },
          },
          {
            orgUnitId: "org-1",
            holidayTitle: "Undefined Holiday",
            holidayRule: undefined,
          },
        ],
        periods: [],
      }

      const result = await Effect.runPromise(buildCalendarConfig(data))

      // Should only have the valid fixed holiday
      expect(result.holidays).toHaveLength(1)
    })
  })
})
