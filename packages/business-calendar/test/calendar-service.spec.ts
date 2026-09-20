import {
  Cause,
  DateTime,
  Duration,
  Effect,
  Fiber,
  LogLevel,
  Logger,
  Option,
} from "effect"
import {
  type BusinessCalendarConfig,
  BusinessCalendarService,
  Friday,
  Monday,
  Saturday,
  Sunday,
  Thursday,
  Tuesday,
  Wednesday,
  easterRelativeHoliday,
  fixedHoliday,
  makeBusinessCalendarServiceLayer,
  makeDateTimeWithTime,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

/** Alias for test readability */
const makeDateTime = makeDateTimeWithTime

const standardConfig: BusinessCalendarConfig = {
  weeklySchedule: [
    {
      day: Monday,
      ranges: [
        { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
      ],
    },
    {
      day: Tuesday,
      ranges: [
        { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
      ],
    },
    {
      day: Wednesday,
      ranges: [
        { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
      ],
    },
    {
      day: Thursday,
      ranges: [
        { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
      ],
    },
    {
      day: Friday,
      ranges: [
        { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
      ],
    },
  ],
  holidays: [
    fixedHoliday("Christmas", 12, 25),
    fixedHoliday("Boxing Day", 12, 26),
    easterRelativeHoliday("Good Friday", -2),
  ],
  exceptions: [],
  nonWorkingDays: [Saturday, Sunday],
  periods: [],
}

const layer = makeBusinessCalendarServiceLayer(standardConfig)

const runEffect = <A, E>(
  effect: Effect.Effect<A, E, BusinessCalendarService>,
) => Effect.runPromise(effect.pipe(Effect.provide(layer)))

describe("BusinessCalendarService", () => {
  describe("isBusinessDay", () => {
    it("should return true for a regular weekday", async () => {
      // Monday, January 6, 2025
      const date = makeDateTime(2025, 1, 6)

      const result = await runEffect(
        Effect.flatMap(BusinessCalendarService, (s) => s.isBusinessDay(date)),
      )

      expect(result).toBe(true)
    })

    it("should return false for a weekend", async () => {
      // Saturday, January 4, 2025
      const date = makeDateTime(2025, 1, 4)

      const result = await runEffect(
        Effect.flatMap(BusinessCalendarService, (s) => s.isBusinessDay(date)),
      )

      expect(result).toBe(false)
    })

    it("should return false for Christmas", async () => {
      // Thursday, December 25, 2025
      const date = makeDateTime(2025, 12, 25)

      const result = await runEffect(
        Effect.flatMap(BusinessCalendarService, (s) => s.isBusinessDay(date)),
      )

      expect(result).toBe(false)
    })
  })

  describe("isBusinessHours", () => {
    it("should return true during business hours", async () => {
      // Monday, January 6, 2025 at 10:00
      const datetime = makeDateTime(2025, 1, 6, 10, 0)

      const result = await runEffect(
        Effect.flatMap(BusinessCalendarService, (s) =>
          s.isBusinessHours(datetime),
        ),
      )

      expect(result).toBe(true)
    })

    it("should return false outside business hours", async () => {
      // Monday, January 6, 2025 at 20:00
      const datetime = makeDateTime(2025, 1, 6, 20, 0)

      const result = await runEffect(
        Effect.flatMap(BusinessCalendarService, (s) =>
          s.isBusinessHours(datetime),
        ),
      )

      expect(result).toBe(false)
    })

    it("should return false on weekends", async () => {
      // Saturday, January 4, 2025 at 10:00
      const datetime = makeDateTime(2025, 1, 4, 10, 0)

      const result = await runEffect(
        Effect.flatMap(BusinessCalendarService, (s) =>
          s.isBusinessHours(datetime),
        ),
      )

      expect(result).toBe(false)
    })
  })

  describe("addBusinessDays", () => {
    it("should skip weekends when adding days", async () => {
      // Friday, January 3, 2025
      const friday = makeDateTime(2025, 1, 3)

      const result = await runEffect(
        Effect.flatMap(BusinessCalendarService, (s) =>
          s.addBusinessDays(friday, 1),
        ),
      )

      const parts = DateTime.toParts(result)
      // Should be Monday, January 6, 2025
      expect(parts.year).toBe(2025)
      expect(parts.month).toBe(1)
      expect(parts.day).toBe(6)
    })

    it("should skip holidays when adding days", async () => {
      // Wednesday, December 24, 2025
      const christmas_eve = makeDateTime(2025, 12, 24)

      const result = await runEffect(
        Effect.flatMap(BusinessCalendarService, (s) =>
          s.addBusinessDays(christmas_eve, 1),
        ),
      )

      const parts = DateTime.toParts(result)
      // Should skip Dec 25 (Christmas), Dec 26 (Boxing Day), Dec 27 (Sat), Dec 28 (Sun)
      // Next business day is Monday, December 29, 2025
      expect(parts.year).toBe(2025)
      expect(parts.month).toBe(12)
      expect(parts.day).toBe(29)
    })
  })

  describe("businessDaysBetween", () => {
    it("should count business days correctly", async () => {
      // Monday, January 6, 2025 to Friday, January 10, 2025
      const start = makeDateTime(2025, 1, 6)
      const end = makeDateTime(2025, 1, 10)

      const result = await runEffect(
        Effect.flatMap(BusinessCalendarService, (s) =>
          s.businessDaysBetween(start, end),
        ),
      )

      // Mon, Tue, Wed, Thu = 4 business days
      expect(result).toBe(4)
    })

    it("should exclude weekends", async () => {
      // Friday, January 3, 2025 to Monday, January 6, 2025
      const start = makeDateTime(2025, 1, 3)
      const end = makeDateTime(2025, 1, 6)

      const result = await runEffect(
        Effect.flatMap(BusinessCalendarService, (s) =>
          s.businessDaysBetween(start, end),
        ),
      )

      // Only Friday = 1 business day
      expect(result).toBe(1)
    })

    it("should count Friday and Monday when spanning to Tuesday", async () => {
      // Friday, January 3, 2025 16:00 to Tuesday, January 7, 2025 10:00
      const start = makeDateTime(2025, 1, 3, 16, 0)
      const end = makeDateTime(2025, 1, 7, 10, 0)

      const result = await runEffect(
        Effect.flatMap(BusinessCalendarService, (s) =>
          s.businessDaysBetween(start, end),
        ),
      )

      // Friday + Monday = 2 business days (Sat/Sun are skipped, Tue 10:00 is after Mon 16:00)
      expect(result).toBe(2)
    })
  })

  describe("businessDayStart", () => {
    it("should return the start time for a business day", async () => {
      // Monday, January 6, 2025
      const date = makeDateTime(2025, 1, 6)

      const result = await runEffect(
        Effect.flatMap(BusinessCalendarService, (s) =>
          s.businessDayStart(date),
        ),
      )

      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result)) {
        const parts = DateTime.toParts(result.value)
        expect(parts.hours).toBe(9)
        expect(parts.minutes).toBe(0)
      }
    })

    it("should return None for a weekend", async () => {
      // Saturday, January 4, 2025
      const date = makeDateTime(2025, 1, 4)

      const result = await runEffect(
        Effect.flatMap(BusinessCalendarService, (s) =>
          s.businessDayStart(date),
        ),
      )

      expect(Option.isNone(result)).toBe(true)
    })
  })

  describe("isHoliday", () => {
    it("should return true for Christmas", async () => {
      const date = makeDateTime(2025, 12, 25)

      const result = await runEffect(
        Effect.flatMap(BusinessCalendarService, (s) => s.isHoliday(date)),
      )

      expect(result).toBe(true)
    })

    it("should return false for a regular day", async () => {
      const date = makeDateTime(2025, 1, 6)

      const result = await runEffect(
        Effect.flatMap(BusinessCalendarService, (s) => s.isHoliday(date)),
      )

      expect(result).toBe(false)
    })
  })

  describe("nextBusinessDay", () => {
    it("should return next business day after a weekday", async () => {
      // Monday, January 6, 2025
      const monday = makeDateTime(2025, 1, 6)

      const result = await runEffect(
        Effect.flatMap(BusinessCalendarService, (s) =>
          s.nextBusinessDay(monday),
        ),
      )

      const parts = DateTime.toParts(result)
      // Should be Tuesday, January 7, 2025
      expect(parts.year).toBe(2025)
      expect(parts.month).toBe(1)
      expect(parts.day).toBe(7)
    })

    it("should skip weekend to Monday", async () => {
      // Friday, January 3, 2025
      const friday = makeDateTime(2025, 1, 3)

      const result = await runEffect(
        Effect.flatMap(BusinessCalendarService, (s) =>
          s.nextBusinessDay(friday),
        ),
      )

      const parts = DateTime.toParts(result)
      // Should be Monday, January 6, 2025
      expect(parts.year).toBe(2025)
      expect(parts.month).toBe(1)
      expect(parts.day).toBe(6)
    })

    it("should skip holidays", async () => {
      // Wednesday, December 24, 2025 (Christmas Eve)
      const christmasEve = makeDateTime(2025, 12, 24)

      const result = await runEffect(
        Effect.flatMap(BusinessCalendarService, (s) =>
          s.nextBusinessDay(christmasEve),
        ),
      )

      const parts = DateTime.toParts(result)
      // Should skip Dec 25 (Christmas), Dec 26 (Boxing Day), Dec 27 (Sat), Dec 28 (Sun)
      // Next business day is Monday, December 29, 2025
      expect(parts.year).toBe(2025)
      expect(parts.month).toBe(12)
      expect(parts.day).toBe(29)
    })
  })

  describe("previousBusinessDay", () => {
    it("should return previous business day before a weekday", async () => {
      // Tuesday, January 7, 2025
      const tuesday = makeDateTime(2025, 1, 7)

      const result = await runEffect(
        Effect.flatMap(BusinessCalendarService, (s) =>
          s.previousBusinessDay(tuesday),
        ),
      )

      const parts = DateTime.toParts(result)
      // Should be Monday, January 6, 2025
      expect(parts.year).toBe(2025)
      expect(parts.month).toBe(1)
      expect(parts.day).toBe(6)
    })

    it("should skip weekend to Friday", async () => {
      // Monday, January 6, 2025
      const monday = makeDateTime(2025, 1, 6)

      const result = await runEffect(
        Effect.flatMap(BusinessCalendarService, (s) =>
          s.previousBusinessDay(monday),
        ),
      )

      const parts = DateTime.toParts(result)
      // Should be Friday, January 3, 2025
      expect(parts.year).toBe(2025)
      expect(parts.month).toBe(1)
      expect(parts.day).toBe(3)
    })

    it("should skip holidays going backward", async () => {
      // Monday, December 29, 2025 (first business day after Christmas)
      const dec29 = makeDateTime(2025, 12, 29)

      const result = await runEffect(
        Effect.flatMap(BusinessCalendarService, (s) =>
          s.previousBusinessDay(dec29),
        ),
      )

      const parts = DateTime.toParts(result)
      // Should skip Dec 28 (Sun), Dec 27 (Sat), Dec 26 (Boxing Day), Dec 25 (Christmas)
      // Previous business day is Wednesday, December 24, 2025
      expect(parts.year).toBe(2025)
      expect(parts.month).toBe(12)
      expect(parts.day).toBe(24)
    })
  })

  describe("getHolidaysForYear", () => {
    it("should return all holidays for a year", async () => {
      const result = await runEffect(
        Effect.flatMap(BusinessCalendarService, (s) =>
          s.getHolidaysForYear(2025),
        ),
      )

      expect(result.length).toBe(3) // Christmas, Boxing Day, Good Friday
      expect(result.some((h) => h.name === "Christmas")).toBe(true)
      expect(result.some((h) => h.name === "Boxing Day")).toBe(true)
      expect(result.some((h) => h.name === "Good Friday")).toBe(true)
    })
  })

  describe("input validation", () => {
    describe("addBusinessDays", () => {
      it("should return same date for zero days", async () => {
        const date = makeDateTime(2025, 1, 6)

        const result = await runEffect(
          Effect.flatMap(BusinessCalendarService, (s) =>
            s.addBusinessDays(date, 0),
          ),
        )

        expect(DateTime.toEpochMillis(result)).toBe(
          DateTime.toEpochMillis(date),
        )
      })

      it("should handle negative days", async () => {
        // Monday, January 6, 2025
        const monday = makeDateTime(2025, 1, 6)

        const result = await runEffect(
          Effect.flatMap(BusinessCalendarService, (s) =>
            s.addBusinessDays(monday, -1),
          ),
        )

        const parts = DateTime.toParts(result)
        // Should be Friday, January 3, 2025
        expect(parts.year).toBe(2025)
        expect(parts.month).toBe(1)
        expect(parts.day).toBe(3)
      })

      it("should return same date for NaN", async () => {
        const date = makeDateTime(2025, 1, 6)

        const result = await runEffect(
          Effect.flatMap(BusinessCalendarService, (s) =>
            s.addBusinessDays(date, Number.NaN),
          ),
        )

        expect(DateTime.toEpochMillis(result)).toBe(
          DateTime.toEpochMillis(date),
        )
      })

      it("should return same date for Infinity", async () => {
        const date = makeDateTime(2025, 1, 6)

        const result = await runEffect(
          Effect.flatMap(BusinessCalendarService, (s) =>
            s.addBusinessDays(date, Number.POSITIVE_INFINITY),
          ),
        )

        expect(DateTime.toEpochMillis(result)).toBe(
          DateTime.toEpochMillis(date),
        )
      })

      it("should handle fractional days by rounding", async () => {
        const friday = makeDateTime(2025, 1, 3)

        const result = await runEffect(
          Effect.flatMap(BusinessCalendarService, (s) =>
            s.addBusinessDays(friday, 1.7),
          ),
        )

        const parts = DateTime.toParts(result)
        // 1.7 rounds to 2, so should be Tuesday, January 7, 2025
        expect(parts.year).toBe(2025)
        expect(parts.month).toBe(1)
        expect(parts.day).toBe(7)
      })
    })

    describe("addBusinessHours", () => {
      it("should return same datetime for zero hours", async () => {
        const datetime = makeDateTime(2025, 1, 6, 10, 0)

        const result = await runEffect(
          Effect.flatMap(BusinessCalendarService, (s) =>
            s.addBusinessHours(datetime, 0),
          ),
        )

        expect(DateTime.toEpochMillis(result)).toBe(
          DateTime.toEpochMillis(datetime),
        )
      })

      it("should return same datetime for negative hours", async () => {
        const datetime = makeDateTime(2025, 1, 6, 10, 0)

        const result = await runEffect(
          Effect.flatMap(BusinessCalendarService, (s) =>
            s.addBusinessHours(datetime, -5),
          ),
        )

        expect(DateTime.toEpochMillis(result)).toBe(
          DateTime.toEpochMillis(datetime),
        )
      })

      it("should return same datetime for NaN", async () => {
        const datetime = makeDateTime(2025, 1, 6, 10, 0)

        const result = await runEffect(
          Effect.flatMap(BusinessCalendarService, (s) =>
            s.addBusinessHours(datetime, Number.NaN),
          ),
        )

        expect(DateTime.toEpochMillis(result)).toBe(
          DateTime.toEpochMillis(datetime),
        )
      })
    })
  })

  describe("businessHoursBetween", () => {
    const hoursBetweenMs = async (
      start: DateTime.Utc,
      end: DateTime.Utc,
      config: BusinessCalendarConfig = standardConfig,
    ): Promise<number> => {
      const configLayer = makeBusinessCalendarServiceLayer(config)
      const duration = await Effect.runPromise(
        Effect.flatMap(BusinessCalendarService, (s) =>
          s.businessHoursBetween(start, end),
        ).pipe(Effect.provide(configLayer)),
      )
      return Duration.toMillis(duration)
    }

    const hour = 60 * 60 * 1000

    it("returns zero when end is before or equal to start", async () => {
      const start = makeDateTime(2025, 1, 6, 10, 0)
      expect(await hoursBetweenMs(start, start)).toBe(0)
      expect(await hoursBetweenMs(start, makeDateTime(2025, 1, 6, 9, 0))).toBe(
        0,
      )
    })

    it("counts a same-day full business day (9:00-17:00 = 8h)", async () => {
      const start = makeDateTime(2025, 1, 6, 9, 0)
      const end = makeDateTime(2025, 1, 6, 17, 0)
      expect(await hoursBetweenMs(start, end)).toBe(8 * hour)
    })

    it("counts partial same-day hours", async () => {
      // Mon 10:30-15:00 = 4.5 hours
      const start = makeDateTime(2025, 1, 6, 10, 30)
      const end = makeDateTime(2025, 1, 6, 15, 0)
      expect(await hoursBetweenMs(start, end)).toBe(4.5 * hour)
    })

    it("spans a weekend (Fri 16:00 - Mon 10:00 = 2h)", async () => {
      const start = makeDateTime(2025, 1, 3, 16, 0)
      const end = makeDateTime(2025, 1, 6, 10, 0)
      expect(await hoursBetweenMs(start, end)).toBe(2 * hour)
    })

    it("spans holidays (Dec 24 16:00 - Dec 29 10:00 = 2h)", async () => {
      // Wed 24: 1h, Christmas/Boxing/weekend: 0, Mon 29: 1h
      const start = makeDateTime(2025, 12, 24, 16, 0)
      const end = makeDateTime(2025, 12, 29, 10, 0)
      expect(await hoursBetweenMs(start, end)).toBe(2 * hour)
    })

    it("counts a full business week (Mon 9:00 - Fri 17:00 = 40h)", async () => {
      const start = makeDateTime(2025, 1, 6, 9, 0)
      const end = makeDateTime(2025, 1, 10, 17, 0)
      expect(await hoursBetweenMs(start, end)).toBe(40 * hour)
    })

    it("respects split-shift lunch breaks", async () => {
      const splitConfig: BusinessCalendarConfig = {
        weeklySchedule: [
          {
            day: Monday,
            ranges: [
              { open: { hour: 9, minute: 0 }, close: { hour: 12, minute: 0 } },
              { open: { hour: 13, minute: 0 }, close: { hour: 17, minute: 0 } },
            ],
          },
        ],
        holidays: [],
        exceptions: [],
        nonWorkingDays: [Saturday, Sunday],
        periods: [],
      }
      // 11:00-14:00 = 1h morning + 1h afternoon
      const start = makeDateTime(2025, 1, 6, 11, 0)
      const end = makeDateTime(2025, 1, 6, 14, 0)
      expect(await hoursBetweenMs(start, end, splitConfig)).toBe(2 * hour)
    })

    it("handles overnight ranges across midnight", async () => {
      const overnightConfig: BusinessCalendarConfig = {
        weeklySchedule: [
          {
            day: Monday,
            ranges: [
              { open: { hour: 22, minute: 0 }, close: { hour: 6, minute: 0 } },
            ],
          },
          {
            day: Tuesday,
            ranges: [
              { open: { hour: 22, minute: 0 }, close: { hour: 6, minute: 0 } },
            ],
          },
        ],
        holidays: [],
        exceptions: [],
        nonWorkingDays: [Saturday, Sunday],
        periods: [],
      }
      // Mon 23:00 - Tue 04:00 = 1h + 4h = 5h
      const start = makeDateTime(2025, 1, 6, 23, 0)
      const end = makeDateTime(2025, 1, 7, 4, 0)
      expect(await hoursBetweenMs(start, end, overnightConfig)).toBe(5 * hour)
    })

    it("respects one-off exception closed days", async () => {
      const withException: BusinessCalendarConfig = {
        ...standardConfig,
        exceptions: [
          {
            date: makeDateTime(2025, 1, 7), // Tuesday
            slots: "closed",
            reason: "Company offsite",
          },
        ],
      }
      // Mon 9:00 - Wed 17:00: Mon 8h + Tue 0 + Wed 8h = 16h
      const start = makeDateTime(2025, 1, 6, 9, 0)
      const end = makeDateTime(2025, 1, 8, 17, 0)
      expect(await hoursBetweenMs(start, end, withException)).toBe(16 * hour)
    })

    it("respects exception custom slots", async () => {
      const withException: BusinessCalendarConfig = {
        ...standardConfig,
        exceptions: [
          {
            date: makeDateTime(2025, 1, 7), // Tuesday half day 9-13
            slots: [
              { open: { hour: 9, minute: 0 }, close: { hour: 13, minute: 0 } },
            ],
            reason: "Half day",
          },
        ],
      }
      // Mon 9-17 (8h) + Tue 9-13 (4h) + Wed 9-17 (8h) = 20h
      const start = makeDateTime(2025, 1, 6, 9, 0)
      const end = makeDateTime(2025, 1, 8, 17, 0)
      expect(await hoursBetweenMs(start, end, withException)).toBe(20 * hour)
    })

    it("counts a multi-month span excluding weekends and holidays", async () => {
      // Jan 6 2025 (Mon 9:00) through Mar 7 2025 (Fri 17:00)
      // Business days in range [Jan 6, Mar 7] inclusive:
      // Jan 6–31: Mon–Fri excluding none in holiday set for Jan → 20 days
      // Feb 2025: 20 weekdays (no holidays in standardConfig for Feb)
      // Mar 1–7: Mon–Fri → 5 days
      // Total 45 business days × 8h = 360h
      // (Christmas/Boxing Day are in Dec only; Good Friday 2025 is Apr 18)
      const start = makeDateTime(2025, 1, 6, 9, 0)
      const end = makeDateTime(2025, 3, 7, 17, 0)
      expect(await hoursBetweenMs(start, end)).toBe(45 * 8 * hour)
    })

    it("handles DST spring-forward in a zoned calendar", async () => {
      // America/New_York: 2025-03-09 clocks spring forward 02:00 → 03:00.
      // Business hours 09:00-17:00 local still total 8h that day.
      const nyConfig: BusinessCalendarConfig = {
        ...standardConfig,
        timezone: "America/New_York",
        holidays: [],
      }
      const layer = makeBusinessCalendarServiceLayer(nyConfig)

      // Build local NY times as UTC via zoned construction
      const makeNy = (
        year: number,
        month: number,
        day: number,
        hour: number,
        minute: number,
      ): DateTime.Utc => {
        const zoned = DateTime.unsafeMakeZoned(
          {
            year,
            month,
            day,
            hours: hour,
            minutes: minute,
            seconds: 0,
            millis: 0,
          },
          {
            timeZone: DateTime.zoneUnsafeMakeNamed("America/New_York"),
            adjustForTimeZone: true,
          },
        )
        return DateTime.toUtc(zoned)
      }

      // Fri Mar 7 9:00 NY → Mon Mar 10 17:00 NY
      // Fri 8h + Mon 8h = 16h (weekend + DST Sunday skipped)
      const start = makeNy(2025, 3, 7, 9, 0)
      const end = makeNy(2025, 3, 10, 17, 0)
      const duration = await Effect.runPromise(
        Effect.flatMap(BusinessCalendarService, (s) =>
          s.businessHoursBetween(start, end),
        ).pipe(Effect.provide(layer)),
      )
      expect(Duration.toMillis(duration)).toBe(16 * hour)

      // Full DST transition day Mon Mar 10: still 8 business hours
      const dayStart = makeNy(2025, 3, 10, 9, 0)
      const dayEnd = makeNy(2025, 3, 10, 17, 0)
      const dayDuration = await Effect.runPromise(
        Effect.flatMap(BusinessCalendarService, (s) =>
          s.businessHoursBetween(dayStart, dayEnd),
        ).pipe(Effect.provide(layer)),
      )
      expect(Duration.toMillis(dayDuration)).toBe(8 * hour)
    })

    it("excludes a middle-day holiday under a UTC+ timezone", async () => {
      // Europe/Berlin: local midnight on a holiday is still the previous UTC date,
      // which previously made middle-day holiday probes miss isDateHoliday.
      const berlinConfig: BusinessCalendarConfig = {
        ...standardConfig,
        timezone: "Europe/Berlin",
        holidays: [fixedHoliday("Christmas", 12, 25)],
      }
      const layer = makeBusinessCalendarServiceLayer(berlinConfig)

      const makeBerlin = (
        year: number,
        month: number,
        day: number,
        hour: number,
        minute: number,
      ): DateTime.Utc => {
        const zoned = DateTime.unsafeMakeZoned(
          {
            year,
            month,
            day,
            hours: hour,
            minutes: minute,
            seconds: 0,
            millis: 0,
          },
          {
            timeZone: DateTime.zoneUnsafeMakeNamed("Europe/Berlin"),
            adjustForTimeZone: true,
          },
        )
        return DateTime.toUtc(zoned)
      }

      // Wed Dec 24 9:00 → Fri Dec 26 17:00 Berlin local
      // Wed 8h + Thu Christmas 0h + Fri 8h = 16h
      const start = makeBerlin(2025, 12, 24, 9, 0)
      const end = makeBerlin(2025, 12, 26, 17, 0)
      const duration = await Effect.runPromise(
        Effect.flatMap(BusinessCalendarService, (s) =>
          s.businessHoursBetween(start, end),
        ).pipe(Effect.provide(layer)),
      )
      expect(Duration.toMillis(duration)).toBe(16 * hour)

      // Local midnight on Christmas must still be a holiday
      const christmasMidnight = makeBerlin(2025, 12, 25, 0, 0)
      const isHoliday = await Effect.runPromise(
        Effect.flatMap(BusinessCalendarService, (s) =>
          s.isHoliday(christmasMidnight),
        ).pipe(Effect.provide(layer)),
      )
      expect(isHoliday).toBe(true)
    })

    it("completes a year-span query in milliseconds", async () => {
      const start = makeDateTime(2025, 1, 6, 9, 0)
      const end = makeDateTime(2026, 1, 6, 9, 0)

      const t0 = performance.now()
      const ms = await hoursBetweenMs(start, end)
      const elapsed = performance.now() - t0

      // ~261 weekdays in that window minus Christmas/Boxing/Good Friday
      // Exact value is less important than being non-zero and fast.
      expect(ms).toBeGreaterThan(200 * 8 * hour)
      expect(ms).toBeLessThan(262 * 8 * hour)
      // O(days) should stay far under a second; avoid a tight bound that flakes on CI load
      expect(elapsed).toBeLessThan(2000)
    })
  })

  describe("getHolidaysForYear failure fallback", () => {
    it("logs a warning and returns [] when holiday calculation fails", async () => {
      const logs: Array<{
        level: string
        message: unknown
        cause: Cause.Cause<unknown>
        annotations: Record<string, unknown>
      }> = []

      const capturingLogger = Logger.make(
        ({ logLevel, message, cause, annotations }) => {
          logs.push({
            level: logLevel.label,
            message,
            cause,
            annotations: Object.fromEntries(annotations),
          })
        },
      )

      // Feb 30 is accepted by DayOfMonth branding but fails date validation.
      const badConfig: BusinessCalendarConfig = {
        ...standardConfig,
        holidays: [fixedHoliday("Invalid", 2, 30)],
      }
      const layer = makeBusinessCalendarServiceLayer(badConfig)

      const result = await Effect.runPromise(
        Effect.flatMap(BusinessCalendarService, (s) =>
          s.getHolidaysForYear(2024),
        ).pipe(
          Effect.provide(layer),
          Effect.provide(Logger.replace(Logger.defaultLogger, capturingLogger)),
          Logger.withMinimumLogLevel(LogLevel.Warning),
        ),
      )

      expect(result).toEqual([])

      const warning = logs.find(
        (entry) =>
          entry.level === "WARN" &&
          (entry.message === "Failed to compute holidays for year" ||
            (Array.isArray(entry.message) &&
              entry.message[0] === "Failed to compute holidays for year")),
      )
      expect(warning).toBeDefined()
      if (warning) {
        expect(warning.annotations.year).toBe(2024)
        const failure = Option.getOrUndefined(
          Cause.failureOption(warning.cause),
        )
        expect(failure).toMatchObject({ _tag: "InvalidDateError" })
      }
    })

    it("does not poison the holiday cache after an interrupted first attempt", async () => {
      // Interrupting the first getHolidaysForYear must not leave year N permanently
      // failed or hanging. A later call should recompute successfully.
      const holidays = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* BusinessCalendarService
          const year = 2031
          const fiber = yield* Effect.fork(service.getHolidaysForYear(year))
          // Let the owner register InFlight and reach the interruptible yield.
          yield* Effect.yieldNow()
          yield* Effect.yieldNow()
          yield* Fiber.interrupt(fiber)
          return yield* service.getHolidaysForYear(year)
        }).pipe(Effect.provide(layer)),
      )

      expect(holidays.length).toBeGreaterThan(0)
      expect(holidays.some((h) => h.name === "Christmas")).toBe(true)
    })

    it("interrupted owner does not cancel concurrent joiners", async () => {
      // Joiners share the owner's in-flight deferred; owner interrupt must
      // abandon (retry), not fan-out Cancellation to waiters.
      const [joiner1, joiner2] = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* BusinessCalendarService
          const year = 2032
          const owner = yield* Effect.fork(service.getHolidaysForYear(year))
          // Owner registers InFlight and reaches the interruptible yield.
          yield* Effect.yieldNow()
          yield* Effect.yieldNow()
          const waiterA = yield* Effect.fork(service.getHolidaysForYear(year))
          const waiterB = yield* Effect.fork(service.getHolidaysForYear(year))
          yield* Effect.yieldNow()
          yield* Fiber.interrupt(owner)
          return yield* Effect.all([Fiber.join(waiterA), Fiber.join(waiterB)], {
            concurrency: 2,
          })
        }).pipe(Effect.provide(layer)),
      )

      expect(joiner1.length).toBeGreaterThan(0)
      expect(joiner2.length).toBeGreaterThan(0)
      expect(joiner1.some((h) => h.name === "Christmas")).toBe(true)
      expect(joiner2.some((h) => h.name === "Christmas")).toBe(true)
    })
  })
})
