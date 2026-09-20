import { DateTime, Effect } from "effect"
import {
  type BusinessCalendarConfig,
  type BusinessCalendarServiceShape,
  Friday,
  Monday,
  Saturday,
  Sunday,
  Thursday,
  type TimestampPair,
  Tuesday,
  Wednesday,
  calculateBusinessDurations,
  calculateRawDurations,
  fixedHoliday,
  makeBusinessCalendarService,
  makeDateTimeWithTime,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

/** Alias for test readability */
const makeDateTime = makeDateTimeWithTime

/** Convert DateTime to epoch milliseconds */
const toMillis = (dt: DateTime.Utc): number => DateTime.toEpochMillis(dt)

/** Standard 9-5 Monday-Friday schedule */
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
  ],
  exceptions: [],
  nonWorkingDays: [Saturday, Sunday],
  periods: [],
}

/** Split shift schedule: 9-12, 13-17 */
const splitShiftConfig: BusinessCalendarConfig = {
  weeklySchedule: [
    {
      day: Monday,
      ranges: [
        { open: { hour: 9, minute: 0 }, close: { hour: 12, minute: 0 } },
        { open: { hour: 13, minute: 0 }, close: { hour: 17, minute: 0 } },
      ],
    },
    {
      day: Tuesday,
      ranges: [
        { open: { hour: 9, minute: 0 }, close: { hour: 12, minute: 0 } },
        { open: { hour: 13, minute: 0 }, close: { hour: 17, minute: 0 } },
      ],
    },
    {
      day: Wednesday,
      ranges: [
        { open: { hour: 9, minute: 0 }, close: { hour: 12, minute: 0 } },
        { open: { hour: 13, minute: 0 }, close: { hour: 17, minute: 0 } },
      ],
    },
    {
      day: Thursday,
      ranges: [
        { open: { hour: 9, minute: 0 }, close: { hour: 12, minute: 0 } },
        { open: { hour: 13, minute: 0 }, close: { hour: 17, minute: 0 } },
      ],
    },
    {
      day: Friday,
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

/** Overnight shift schedule: 22:00-06:00 */
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
    {
      day: Wednesday,
      ranges: [
        { open: { hour: 22, minute: 0 }, close: { hour: 6, minute: 0 } },
      ],
    },
    {
      day: Thursday,
      ranges: [
        { open: { hour: 22, minute: 0 }, close: { hour: 6, minute: 0 } },
      ],
    },
    {
      day: Friday,
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

const makeService = (
  config: BusinessCalendarConfig = standardConfig,
): Promise<BusinessCalendarServiceShape> =>
  Effect.runPromise(makeBusinessCalendarService(config))

const runDurations = async (
  pairs: readonly TimestampPair[],
  config: BusinessCalendarConfig = standardConfig,
) => {
  const calendarService = await makeService(config)
  return Effect.runPromise(calculateBusinessDurations(calendarService, pairs))
}

describe("calculateBusinessDurations", () => {
  describe("basic scenarios", () => {
    it("should calculate same-day execution (9:00-17:00 = 8 hours)", async () => {
      // Monday 9:00 to Monday 17:00
      const pairs: TimestampPair[] = [
        {
          id: "process-1",
          createdAt: toMillis(makeDateTime(2025, 1, 6, 9, 0)), // Mon 9:00
          finishedAt: toMillis(makeDateTime(2025, 1, 6, 17, 0)), // Mon 17:00
        },
      ]

      const result = await runDurations(pairs)

      const stats = result.get("process-1")
      expect(stats).toBeDefined()
      expect(stats?.minBusinessDurationMs).toBe(8 * 60 * 60 * 1000) // 8 hours
      expect(stats?.maxBusinessDurationMs).toBe(8 * 60 * 60 * 1000) // 8 hours
    })

    it("should calculate weekend spanning (Fri 16:00 - Mon 10:00 = 2 hours)", async () => {
      // Friday 16:00 to Monday 10:00 = 1h Fri + 1h Mon = 2h
      const pairs: TimestampPair[] = [
        {
          id: "process-1",
          createdAt: toMillis(makeDateTime(2025, 1, 3, 16, 0)), // Fri 16:00
          finishedAt: toMillis(makeDateTime(2025, 1, 6, 10, 0)), // Mon 10:00
        },
      ]

      const result = await runDurations(pairs)

      const stats = result.get("process-1")
      expect(stats).toBeDefined()
      expect(stats?.minBusinessDurationMs).toBe(2 * 60 * 60 * 1000) // 2 hours
    })

    it("should calculate holiday spanning (Dec 24 16:00 - Dec 29 10:00)", async () => {
      // Wed Dec 24 16:00 to Mon Dec 29 10:00
      // Wed 24: 1h (16:00-17:00)
      // Thu 25: Christmas - 0h
      // Fri 26: Boxing Day - 0h
      // Sat 27: Weekend - 0h
      // Sun 28: Weekend - 0h
      // Mon 29: 1h (09:00-10:00)
      // Total: 2h
      const pairs: TimestampPair[] = [
        {
          id: "process-1",
          createdAt: toMillis(makeDateTime(2025, 12, 24, 16, 0)),
          finishedAt: toMillis(makeDateTime(2025, 12, 29, 10, 0)),
        },
      ]

      const result = await runDurations(pairs)

      const stats = result.get("process-1")
      expect(stats).toBeDefined()
      expect(stats?.minBusinessDurationMs).toBe(2 * 60 * 60 * 1000) // 2 hours
    })

    it("should handle empty samples", async () => {
      const pairs: TimestampPair[] = []

      const result = await runDurations(pairs)

      expect(result.size).toBe(0)
    })
  })

  describe("split shift schedule", () => {
    it("should calculate duration across lunch break (11:00-14:00 = 2 hours)", async () => {
      // Monday 11:00 to Monday 14:00
      // 11:00-12:00 = 1h (morning shift)
      // 12:00-13:00 = 0h (lunch break)
      // 13:00-14:00 = 1h (afternoon shift)
      // Total: 2h
      const pairs: TimestampPair[] = [
        {
          id: "process-1",
          createdAt: toMillis(makeDateTime(2025, 1, 6, 11, 0)),
          finishedAt: toMillis(makeDateTime(2025, 1, 6, 14, 0)),
        },
      ]

      const result = await runDurations(pairs, splitShiftConfig)

      const stats = result.get("process-1")
      expect(stats).toBeDefined()
      expect(stats?.minBusinessDurationMs).toBe(2 * 60 * 60 * 1000) // 2 hours
    })
  })

  describe("overnight shift", () => {
    it("should calculate overnight shift (Mon 23:00 - Tue 04:00 = 5 hours)", async () => {
      // Monday 23:00 to Tuesday 04:00
      // 23:00-00:00 = 1h
      // 00:00-04:00 = 4h
      // Total: 5h
      const pairs: TimestampPair[] = [
        {
          id: "process-1",
          createdAt: toMillis(makeDateTime(2025, 1, 6, 23, 0)), // Mon 23:00
          finishedAt: toMillis(makeDateTime(2025, 1, 7, 4, 0)), // Tue 04:00
        },
      ]

      const result = await runDurations(pairs, overnightConfig)

      const stats = result.get("process-1")
      expect(stats).toBeDefined()
      expect(stats?.minBusinessDurationMs).toBe(5 * 60 * 60 * 1000) // 5 hours
    })
  })

  describe("full business week", () => {
    it("should calculate full week (40 hours)", async () => {
      // Monday 9:00 to Friday 17:00 = 5 * 8 = 40 hours
      const pairs: TimestampPair[] = [
        {
          id: "process-1",
          createdAt: toMillis(makeDateTime(2025, 1, 6, 9, 0)), // Mon 9:00
          finishedAt: toMillis(makeDateTime(2025, 1, 10, 17, 0)), // Fri 17:00
        },
      ]

      const result = await runDurations(pairs)

      const stats = result.get("process-1")
      expect(stats).toBeDefined()
      expect(stats?.minBusinessDurationMs).toBe(40 * 60 * 60 * 1000) // 40 hours
    })
  })

  describe("multiple samples", () => {
    it("should calculate min/max from multiple executions", async () => {
      // Three executions for the same process with different durations
      const pairs: TimestampPair[] = [
        {
          id: "process-1",
          createdAt: toMillis(makeDateTime(2025, 1, 6, 9, 0)),
          finishedAt: toMillis(makeDateTime(2025, 1, 6, 11, 0)), // 2 hours
        },
        {
          id: "process-1",
          createdAt: toMillis(makeDateTime(2025, 1, 7, 9, 0)),
          finishedAt: toMillis(makeDateTime(2025, 1, 7, 17, 0)), // 8 hours
        },
        {
          id: "process-1",
          createdAt: toMillis(makeDateTime(2025, 1, 8, 14, 0)),
          finishedAt: toMillis(makeDateTime(2025, 1, 8, 16, 0)), // 2 hours
        },
      ]

      const result = await runDurations(pairs)

      const stats = result.get("process-1")
      expect(stats).toBeDefined()
      expect(stats?.minBusinessDurationMs).toBe(2 * 60 * 60 * 1000) // 2 hours min
      expect(stats?.maxBusinessDurationMs).toBe(8 * 60 * 60 * 1000) // 8 hours max
    })

    it("should handle multiple processes", async () => {
      const pairs: TimestampPair[] = [
        {
          id: "process-1",
          createdAt: toMillis(makeDateTime(2025, 1, 6, 9, 0)),
          finishedAt: toMillis(makeDateTime(2025, 1, 6, 11, 0)), // 2 hours
        },
        {
          id: "process-2",
          createdAt: toMillis(makeDateTime(2025, 1, 6, 9, 0)),
          finishedAt: toMillis(makeDateTime(2025, 1, 6, 14, 0)), // 5 hours
        },
      ]

      const result = await runDurations(pairs)

      expect(result.size).toBe(2)

      const stats1 = result.get("process-1")
      expect(stats1?.minBusinessDurationMs).toBe(2 * 60 * 60 * 1000)

      const stats2 = result.get("process-2")
      expect(stats2?.minBusinessDurationMs).toBe(5 * 60 * 60 * 1000)
    })
  })
})

describe("calculateRawDurations", () => {
  it("should calculate wall-clock duration", () => {
    const pairs: TimestampPair[] = [
      {
        id: "process-1",
        createdAt: toMillis(makeDateTime(2025, 1, 3, 16, 0)), // Fri 16:00
        finishedAt: toMillis(makeDateTime(2025, 1, 6, 10, 0)), // Mon 10:00
      },
    ]

    const result = calculateRawDurations(pairs)

    const stats = result.get("process-1")
    expect(stats).toBeDefined()
    // Wall-clock: Friday 16:00 to Monday 10:00 = 66 hours
    expect(stats?.minBusinessDurationMs).toBe(66 * 60 * 60 * 1000)
  })

  it("should return empty map for empty input", () => {
    const result = calculateRawDurations([])
    expect(result.size).toBe(0)
  })
})
