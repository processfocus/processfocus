import { Effect, Layer } from "effect"
import {
  BusinessCalendarQueries,
  type OrgUnitCalendarData,
} from "@pf/graphql-db-operations"
import {
  type SlaCalculationInput,
  SlaCalculationService,
  SlaCalculationServiceLive,
} from "../src/lib/sla-calculation-service"
import { describe, expect, it } from "bun:test"

/**
 * Mock BusinessCalendarQueries that returns test calendar data.
 */
const mockCalendarQueries = (
  calendarData: Map<string, OrgUnitCalendarData>,
  rootOrgUnitId: string | null = null,
): BusinessCalendarQueries["Type"] => ({
  getCalendarData: (orgUnitIds) =>
    Effect.succeed(
      new Map(
        orgUnitIds
          .map((id) => [id, calendarData.get(id)] as const)
          .filter(([, data]) => data !== undefined) as Array<
          [string, OrgUnitCalendarData]
        >,
      ),
    ),
  getRootOrgUnit: () => Effect.succeed(rootOrgUnitId),
})

/**
 * Create a test layer with mock calendar data.
 */
const makeTestLayer = (
  calendarData: Map<string, OrgUnitCalendarData>,
  rootOrgUnitId: string | null = null,
) =>
  SlaCalculationServiceLive.pipe(
    Layer.provide(
      Layer.succeed(
        BusinessCalendarQueries,
        mockCalendarQueries(calendarData, rootOrgUnitId),
      ),
    ),
  )

describe("SlaCalculationService", () => {
  describe("with no calendar configured", () => {
    const emptyCalendarData = new Map<string, OrgUnitCalendarData>()
    const testLayer = makeTestLayer(emptyCalendarData)

    it("should return null for executions without SLA configured", async () => {
      const input: SlaCalculationInput = {
        id: "exec-1",
        startedAt: "2024-01-15T10:00:00.000Z",
        orgUnitId: "org-1",
        slaValue: null,
        slaUnit: null,
        slaWarning: null,
        typicalDurationMinMs: null,
        typicalDurationMaxMs: null,
      }

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* SlaCalculationService
          return yield* service.calculateSlaTargets([input])
        }).pipe(Effect.provide(testLayer)),
      )

      expect(result.get("exec-1")).toEqual({
        slaTargetAt: null,
        slaWarningAt: null,
        estimatedCompletionAt: null,
      })
    })

    it("should use clock time when no calendar exists (24/7 operation)", async () => {
      const input: SlaCalculationInput = {
        id: "exec-1",
        startedAt: "2024-01-15T10:00:00.000Z",
        orgUnitId: "org-1",
        slaValue: 4,
        slaUnit: "businessHours",
        slaWarning: 80,
        typicalDurationMinMs: null,
        typicalDurationMaxMs: null,
      }

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* SlaCalculationService
          return yield* service.calculateSlaTargets([input])
        }).pipe(Effect.provide(testLayer)),
      )

      // No calendar = use clock time (4 hours from 10:00 = 14:00, 80% warning = 3.2 hours = 13:12)
      expect(result.get("exec-1")).toEqual({
        slaTargetAt: "2024-01-15T14:00:00.000Z",
        slaWarningAt: "2024-01-15T13:12:00.000Z",
        estimatedCompletionAt: null,
      })
    })

    it("should calculate estimated completion using clock time when no calendar exists", async () => {
      const input: SlaCalculationInput = {
        id: "exec-1",
        startedAt: "2024-01-15T10:00:00.000Z",
        orgUnitId: "org-1",
        slaValue: null,
        slaUnit: null,
        slaWarning: null,
        // Has duration data but no calendar - midpoint is 3 hours
        typicalDurationMinMs: 2 * 60 * 60 * 1000,
        typicalDurationMaxMs: 4 * 60 * 60 * 1000,
      }

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* SlaCalculationService
          return yield* service.calculateSlaTargets([input])
        }).pipe(Effect.provide(testLayer)),
      )

      // No calendar = clock time, midpoint of 2-4 hours = 3 hours from 10:00 = 13:00
      expect(result.get("exec-1")).toEqual({
        slaTargetAt: null,
        slaWarningAt: null,
        estimatedCompletionAt: "2024-01-15T13:00:00.000Z",
      })
    })
  })

  describe("with business calendar configured", () => {
    // Standard 9-5 Mon-Fri calendar (UTC for tests)
    const standardCalendar: OrgUnitCalendarData = {
      orgUnitId: "org-1",
      timezone: "UTC",
      weeklySchedule: [
        {
          orgUnitId: "org-1",
          dayOfWeek: 1,
          timeRanges: [
            { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
          ],
        }, // Monday
        {
          orgUnitId: "org-1",
          dayOfWeek: 2,
          timeRanges: [
            { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
          ],
        }, // Tuesday
        {
          orgUnitId: "org-1",
          dayOfWeek: 3,
          timeRanges: [
            { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
          ],
        }, // Wednesday
        {
          orgUnitId: "org-1",
          dayOfWeek: 4,
          timeRanges: [
            { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
          ],
        }, // Thursday
        {
          orgUnitId: "org-1",
          dayOfWeek: 5,
          timeRanges: [
            { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
          ],
        }, // Friday
      ],
      dateExceptions: [],
      holidays: [],
      periods: [],
    }

    const calendarData = new Map([["org-1", standardCalendar]])
    const testLayer = makeTestLayer(calendarData)

    it("should calculate businessHours using business calendar", async () => {
      // Starting at 10:00 AM Monday, adding 4 business hours
      const input: SlaCalculationInput = {
        id: "exec-1",
        startedAt: "2024-01-15T10:00:00.000Z", // Monday 10:00
        orgUnitId: "org-1",
        slaValue: 4,
        slaUnit: "businessHours",
        slaWarning: 80,
        typicalDurationMinMs: null,
        typicalDurationMaxMs: null,
      }

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* SlaCalculationService
          return yield* service.calculateSlaTargets([input])
        }).pipe(Effect.provide(testLayer)),
      )

      // 4 business hours from 10:00 = 14:00 (same day)
      expect(result.get("exec-1")?.slaTargetAt).toBe("2024-01-15T14:00:00.000Z")
      // 80% of 4 hours = 3.2 hours from 10:00 = 13:12
      expect(result.get("exec-1")?.slaWarningAt).toBe(
        "2024-01-15T13:12:00.000Z",
      )
    })

    it("should handle businessDays correctly", async () => {
      // Starting Monday, adding 1 business day
      const input: SlaCalculationInput = {
        id: "exec-1",
        startedAt: "2024-01-15T10:00:00.000Z", // Monday
        orgUnitId: "org-1",
        slaValue: 1,
        slaUnit: "businessDays",
        slaWarning: 50,
        typicalDurationMinMs: null,
        typicalDurationMaxMs: null,
      }

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* SlaCalculationService
          return yield* service.calculateSlaTargets([input])
        }).pipe(Effect.provide(testLayer)),
      )

      // 1 business day from Monday = Tuesday
      expect(result.get("exec-1")?.slaTargetAt).toBe("2024-01-16T10:00:00.000Z")
    })

    it("should calculate businessWeeks based on working days per week", async () => {
      // With 5-day week, 1 business week = 5 business days
      const input: SlaCalculationInput = {
        id: "exec-1",
        startedAt: "2024-01-15T10:00:00.000Z", // Monday
        orgUnitId: "org-1",
        slaValue: 1,
        slaUnit: "businessWeeks",
        slaWarning: null,
        typicalDurationMinMs: null,
        typicalDurationMaxMs: null,
      }

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* SlaCalculationService
          return yield* service.calculateSlaTargets([input])
        }).pipe(Effect.provide(testLayer)),
      )

      // 1 business week (5 days) from Monday Jan 15 = Monday Jan 22
      expect(result.get("exec-1")?.slaTargetAt).toBe("2024-01-22T10:00:00.000Z")
    })

    it("should handle minutes as business minutes", async () => {
      const input: SlaCalculationInput = {
        id: "exec-1",
        startedAt: "2024-01-15T10:00:00.000Z",
        orgUnitId: "org-1",
        slaValue: 90, // 90 minutes = 1.5 hours
        slaUnit: "minutes",
        slaWarning: 80,
        typicalDurationMinMs: null,
        typicalDurationMaxMs: null,
      }

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* SlaCalculationService
          return yield* service.calculateSlaTargets([input])
        }).pipe(Effect.provide(testLayer)),
      )

      // 90 minutes from 10:00 = 11:30
      expect(result.get("exec-1")?.slaTargetAt).toBe("2024-01-15T11:30:00.000Z")
    })

    it("should calculate estimated completion using business hours", async () => {
      // Starting at 4:00 PM Monday (16:00), with 3 hours typical duration
      // 1 hour left on Monday, then 2 hours on Tuesday starting at 9:00 AM = 11:00 AM
      const input: SlaCalculationInput = {
        id: "exec-1",
        startedAt: "2024-01-15T16:00:00.000Z", // Monday 4:00 PM
        orgUnitId: "org-1",
        slaValue: null,
        slaUnit: null,
        slaWarning: null,
        // 3 hours typical duration
        typicalDurationMinMs: 3 * 60 * 60 * 1000,
        typicalDurationMaxMs: 3 * 60 * 60 * 1000,
      }

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* SlaCalculationService
          return yield* service.calculateSlaTargets([input])
        }).pipe(Effect.provide(testLayer)),
      )

      // 3 business hours from 4:00 PM Monday:
      // - 1 hour until 5:00 PM (end of business day)
      // - Then continue next day at 9:00 AM + 2 hours = 11:00 AM Tuesday
      expect(result.get("exec-1")?.estimatedCompletionAt).toBe(
        "2024-01-16T11:00:00.000Z",
      )
    })
  })

  describe("fallback to root org unit calendar", () => {
    const rootCalendar: OrgUnitCalendarData = {
      orgUnitId: "root-org",
      timezone: "UTC",
      weeklySchedule: [
        {
          orgUnitId: "root-org",
          dayOfWeek: 1,
          timeRanges: [
            { open: { hour: 8, minute: 0 }, close: { hour: 16, minute: 0 } },
          ],
        }, // Monday
        {
          orgUnitId: "root-org",
          dayOfWeek: 2,
          timeRanges: [
            { open: { hour: 8, minute: 0 }, close: { hour: 16, minute: 0 } },
          ],
        }, // Tuesday
        {
          orgUnitId: "root-org",
          dayOfWeek: 3,
          timeRanges: [
            { open: { hour: 8, minute: 0 }, close: { hour: 16, minute: 0 } },
          ],
        }, // Wednesday
        {
          orgUnitId: "root-org",
          dayOfWeek: 4,
          timeRanges: [
            { open: { hour: 8, minute: 0 }, close: { hour: 16, minute: 0 } },
          ],
        }, // Thursday
        {
          orgUnitId: "root-org",
          dayOfWeek: 5,
          timeRanges: [
            { open: { hour: 8, minute: 0 }, close: { hour: 16, minute: 0 } },
          ],
        }, // Friday
      ],
      dateExceptions: [],
      holidays: [],
      periods: [],
    }

    const calendarData = new Map([["root-org", rootCalendar]])
    const testLayer = makeTestLayer(calendarData, "root-org")

    it("should use root calendar when child org has no calendar", async () => {
      const input: SlaCalculationInput = {
        id: "exec-1",
        startedAt: "2024-01-15T10:00:00.000Z",
        orgUnitId: "child-org", // Has no calendar
        slaValue: 4,
        slaUnit: "businessHours",
        slaWarning: null,
        typicalDurationMinMs: null,
        typicalDurationMaxMs: null,
      }

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* SlaCalculationService
          return yield* service.calculateSlaTargets([input])
        }).pipe(Effect.provide(testLayer)),
      )

      // Should use root org's 8-16 schedule
      // 4 business hours from 10:00 = 14:00
      expect(result.get("exec-1")?.slaTargetAt).toBe("2024-01-15T14:00:00.000Z")
    })
  })

  describe("batch processing", () => {
    // Use standard calendar for batch tests
    const standardCalendar: OrgUnitCalendarData = {
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
        {
          orgUnitId: "org-1",
          dayOfWeek: 2,
          timeRanges: [
            { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
          ],
        },
        {
          orgUnitId: "org-1",
          dayOfWeek: 3,
          timeRanges: [
            { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
          ],
        },
        {
          orgUnitId: "org-1",
          dayOfWeek: 4,
          timeRanges: [
            { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
          ],
        },
        {
          orgUnitId: "org-1",
          dayOfWeek: 5,
          timeRanges: [
            { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
          ],
        },
      ],
      dateExceptions: [],
      holidays: [],
      periods: [],
    }
    const calendarData = new Map([["org-1", standardCalendar]])
    const testLayer = makeTestLayer(calendarData)

    it("should process multiple executions in a batch", async () => {
      const inputs: SlaCalculationInput[] = [
        {
          id: "exec-1",
          startedAt: "2024-01-15T10:00:00.000Z",
          orgUnitId: "org-1",
          slaValue: 4,
          slaUnit: "businessHours",
          slaWarning: 80,
          typicalDurationMinMs: null,
          typicalDurationMaxMs: null,
        },
        {
          id: "exec-2",
          startedAt: "2024-01-16T09:00:00.000Z",
          orgUnitId: "org-1",
          slaValue: 2,
          slaUnit: "businessDays",
          slaWarning: null,
          typicalDurationMinMs: null,
          typicalDurationMaxMs: null,
        },
        {
          id: "exec-3",
          startedAt: "2024-01-17T14:00:00.000Z",
          orgUnitId: "org-2", // No calendar for org-2
          slaValue: null,
          slaUnit: null,
          slaWarning: null,
          typicalDurationMinMs: null,
          typicalDurationMaxMs: null,
        },
      ]

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* SlaCalculationService
          return yield* service.calculateSlaTargets(inputs)
        }).pipe(Effect.provide(testLayer)),
      )

      expect(result.size).toBe(3)
      // org-1 has calendar - should calculate
      expect(result.get("exec-1")?.slaTargetAt).not.toBeNull()
      expect(result.get("exec-2")?.slaTargetAt).not.toBeNull()
      // org-2 has no calendar and no SLA configured - all null
      expect(result.get("exec-3")).toEqual({
        slaTargetAt: null,
        slaWarningAt: null,
        estimatedCompletionAt: null,
      })
    })

    it("should return empty map for empty input", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* SlaCalculationService
          return yield* service.calculateSlaTargets([])
        }).pipe(Effect.provide(testLayer)),
      )

      expect(result.size).toBe(0)
    })
  })

  describe("6-day work week", () => {
    // Calendar with Mon-Sat working days (UTC for tests)
    const sixDayCalendar: OrgUnitCalendarData = {
      orgUnitId: "org-1",
      timezone: "UTC",
      weeklySchedule: [
        {
          orgUnitId: "org-1",
          dayOfWeek: 1,
          timeRanges: [
            { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
          ],
        }, // Monday
        {
          orgUnitId: "org-1",
          dayOfWeek: 2,
          timeRanges: [
            { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
          ],
        }, // Tuesday
        {
          orgUnitId: "org-1",
          dayOfWeek: 3,
          timeRanges: [
            { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
          ],
        }, // Wednesday
        {
          orgUnitId: "org-1",
          dayOfWeek: 4,
          timeRanges: [
            { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
          ],
        }, // Thursday
        {
          orgUnitId: "org-1",
          dayOfWeek: 5,
          timeRanges: [
            { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
          ],
        }, // Friday
        {
          orgUnitId: "org-1",
          dayOfWeek: 6,
          timeRanges: [
            { open: { hour: 9, minute: 0 }, close: { hour: 13, minute: 0 } },
          ],
        }, // Saturday (half day)
      ],
      dateExceptions: [],
      holidays: [],
      periods: [],
    }

    const calendarData = new Map([["org-1", sixDayCalendar]])
    const testLayer = makeTestLayer(calendarData)

    it("should calculate businessWeeks with 6-day work week", async () => {
      const input: SlaCalculationInput = {
        id: "exec-1",
        startedAt: "2024-01-15T10:00:00.000Z", // Monday
        orgUnitId: "org-1",
        slaValue: 1,
        slaUnit: "businessWeeks",
        slaWarning: null,
        typicalDurationMinMs: null,
        typicalDurationMaxMs: null,
      }

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* SlaCalculationService
          return yield* service.calculateSlaTargets([input])
        }).pipe(Effect.provide(testLayer)),
      )

      // 1 business week with 6-day week = 6 business days
      // Monday Jan 15 + 6 days = Sunday Jan 21 (which is not a working day)
      // So it should land on Monday Jan 22
      expect(result.get("exec-1")?.slaTargetAt).toBe("2024-01-22T10:00:00.000Z")
    })
  })

  describe("timezone-aware calculations", () => {
    // Calendar with 8:30-17:00 in Pacific/Auckland timezone
    const nzCalendar: OrgUnitCalendarData = {
      orgUnitId: "org-nz",
      timezone: "Pacific/Auckland",
      weeklySchedule: [
        {
          orgUnitId: "org-nz",
          dayOfWeek: 1,
          timeRanges: [
            { open: { hour: 8, minute: 30 }, close: { hour: 17, minute: 0 } },
          ],
        }, // Monday
        {
          orgUnitId: "org-nz",
          dayOfWeek: 2,
          timeRanges: [
            { open: { hour: 8, minute: 30 }, close: { hour: 17, minute: 0 } },
          ],
        }, // Tuesday
        {
          orgUnitId: "org-nz",
          dayOfWeek: 3,
          timeRanges: [
            { open: { hour: 8, minute: 30 }, close: { hour: 17, minute: 0 } },
          ],
        }, // Wednesday
        {
          orgUnitId: "org-nz",
          dayOfWeek: 4,
          timeRanges: [
            { open: { hour: 8, minute: 30 }, close: { hour: 17, minute: 0 } },
          ],
        }, // Thursday
        {
          orgUnitId: "org-nz",
          dayOfWeek: 5,
          timeRanges: [
            { open: { hour: 8, minute: 30 }, close: { hour: 17, minute: 0 } },
          ],
        }, // Friday
      ],
      dateExceptions: [],
      holidays: [],
      periods: [],
    }

    const calendarData = new Map([["org-nz", nzCalendar]])
    const testLayer = makeTestLayer(calendarData)

    it("should calculate SLA target in NZ timezone correctly", async () => {
      // Start at 7:00 AM NZT on a Monday (which is 6:00 PM UTC Sunday)
      // Since 7:00 AM is before business hours (8:30 AM), the SLA should
      // start counting from 8:30 AM NZT
      // With 1 business day SLA, it should end at end of that business day
      const input: SlaCalculationInput = {
        id: "exec-nz",
        // 2024-01-14T18:00:00Z = 2024-01-15T07:00:00 NZT (Monday 7:00 AM)
        startedAt: "2024-01-14T18:00:00.000Z",
        orgUnitId: "org-nz",
        slaValue: 1,
        slaUnit: "businessDays",
        slaWarning: null,
        typicalDurationMinMs: null,
        typicalDurationMaxMs: null,
      }

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* SlaCalculationService
          return yield* service.calculateSlaTargets([input])
        }).pipe(Effect.provide(testLayer)),
      )

      // addBusinessDays(1) adds 1 calendar day skipping non-business days
      // From Monday (in NZT), +1 business day = Tuesday (in NZT)
      // The time of day is preserved in local time:
      // Input: Monday 7:00 AM NZT -> Output: Tuesday 7:00 AM NZT
      // Tuesday 7:00 AM NZT = 2024-01-15T18:00:00Z
      expect(result.get("exec-nz")?.slaTargetAt).toBe(
        "2024-01-15T18:00:00.000Z",
      )
    })

    it("should calculate business hours correctly across timezone boundaries", async () => {
      // Start at 4:00 PM NZT (within business hours)
      // 2024-01-15T03:00:00Z = 2024-01-15T16:00:00 NZT (Monday 4:00 PM)
      // 2 business hours from 4:00 PM NZT:
      // - 1 hour until 5:00 PM (end of business day)
      // - Then continue next day at 8:30 AM NZT + 1 hour = 9:30 AM NZT
      const input: SlaCalculationInput = {
        id: "exec-nz-hours",
        startedAt: "2024-01-15T03:00:00.000Z", // 4:00 PM NZT Monday
        orgUnitId: "org-nz",
        slaValue: 2,
        slaUnit: "businessHours",
        slaWarning: null,
        typicalDurationMinMs: null,
        typicalDurationMaxMs: null,
      }

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* SlaCalculationService
          return yield* service.calculateSlaTargets([input])
        }).pipe(Effect.provide(testLayer)),
      )

      // 2 business hours:
      // - 1 hour from 4:00 PM to 5:00 PM NZT on Monday
      // - 1 hour from 8:30 AM to 9:30 AM NZT on Tuesday
      // Tuesday 9:30 AM NZT = 2024-01-15T20:30:00Z
      expect(result.get("exec-nz-hours")?.slaTargetAt).toBe(
        "2024-01-15T20:30:00.000Z",
      )
    })

    it("should calculate estimated completion with timezone-aware business hours", async () => {
      // Start at 4:00 PM NZT (within business hours) with 3-hour typical duration
      // 2024-01-15T03:00:00Z = 2024-01-15T16:00:00 NZT (Monday 4:00 PM)
      const input: SlaCalculationInput = {
        id: "exec-nz-est",
        startedAt: "2024-01-15T03:00:00.000Z", // 4:00 PM NZT Monday
        orgUnitId: "org-nz",
        slaValue: null,
        slaUnit: null,
        slaWarning: null,
        // 3 hours typical duration
        typicalDurationMinMs: 3 * 60 * 60 * 1000,
        typicalDurationMaxMs: 3 * 60 * 60 * 1000,
      }

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* SlaCalculationService
          return yield* service.calculateSlaTargets([input])
        }).pipe(Effect.provide(testLayer)),
      )

      // 3 business hours from 4:00 PM NZT:
      // - 1 hour from 4:00 PM to 5:00 PM NZT on Monday
      // - 2 hours from 8:30 AM to 10:30 AM NZT on Tuesday
      // Tuesday 10:30 AM NZT = 2024-01-15T21:30:00Z
      expect(result.get("exec-nz-est")?.estimatedCompletionAt).toBe(
        "2024-01-15T21:30:00.000Z",
      )
    })
  })
})
