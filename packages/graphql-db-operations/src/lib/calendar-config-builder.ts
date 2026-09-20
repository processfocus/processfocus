import { Data, DateTime, Effect } from "effect"
import type {
  BusinessCalendarConfig,
  CalendarPeriod,
  DayOfWeek,
  DaySchedule,
  Holiday,
} from "@pf/business-calendar"
import type { OrgUnitCalendarData } from "./business-calendar-queries"

/**
 * Error when calendar data contains invalid values.
 */
export class InvalidCalendarDataError extends Data.TaggedError(
  "@pf/InvalidCalendarDataError",
)<{
  readonly message: string
  readonly orgUnitId: string
  readonly field: string
  readonly value: unknown
}> {}

/**
 * Check if calendar data has any schedule configured.
 */
export const hasCalendarConfigured = (data: OrgUnitCalendarData): boolean =>
  data.weeklySchedule.length > 0

/**
 * Check if a value is a valid day of week (0-6).
 */
export const isValidDayOfWeek = (value: number): value is DayOfWeek =>
  Number.isInteger(value) && value >= 0 && value <= 6

/**
 * Validate and convert a DaySchedule array from JSON.
 * Returns undefined if input is undefined/null, validates structure if present.
 */
const validatePeriodSchedule = (
  schedule: unknown,
  orgUnitId: string,
  periodTitle: string,
): Effect.Effect<DaySchedule[] | undefined, InvalidCalendarDataError> =>
  Effect.gen(function* () {
    if (schedule === undefined || schedule === null) {
      return undefined
    }
    if (!Array.isArray(schedule)) {
      return yield* new InvalidCalendarDataError({
        message: `Period schedule must be an array`,
        orgUnitId,
        field: `periods.${periodTitle}.weeklySchedule`,
        value: schedule,
      })
    }
    // Basic structural validation - the business-calendar package will do full validation
    return schedule as DaySchedule[]
  })

/**
 * Build BusinessCalendarConfig from database data with validation.
 *
 * Validates all data and returns proper Effect errors for invalid values.
 */
export const buildCalendarConfig = (
  data: OrgUnitCalendarData,
): Effect.Effect<BusinessCalendarConfig, InvalidCalendarDataError> =>
  Effect.gen(function* () {
    // Build and validate weekly schedule from rows
    const weeklySchedule: DaySchedule[] = []
    for (const row of data.weeklySchedule) {
      if (!isValidDayOfWeek(row.dayOfWeek)) {
        return yield* new InvalidCalendarDataError({
          message: `Invalid day of week: ${row.dayOfWeek}`,
          orgUnitId: data.orgUnitId,
          field: "weeklySchedule.dayOfWeek",
          value: row.dayOfWeek,
        })
      }
      weeklySchedule.push({
        day: row.dayOfWeek,
        ranges: row.timeRanges,
      })
    }

    // Build holidays from rules (filter nulls)
    const holidays: Holiday[] = data.holidays
      .map((row) => row.holidayRule as Holiday)
      .filter((h): h is Holiday => h !== null && h !== undefined)

    // Build date exceptions with validated dates
    const exceptions: Array<{
      date: DateTime.Utc
      slots: (typeof data.dateExceptions)[number]["exceptionSlots"]
      note: string | undefined
    }> = []
    for (const row of data.dateExceptions) {
      const dateResult = DateTime.make(row.exceptionDate)
      if (dateResult._tag === "None") {
        return yield* new InvalidCalendarDataError({
          message: `Invalid exception date: ${row.exceptionDate}`,
          orgUnitId: data.orgUnitId,
          field: "dateExceptions.exceptionDate",
          value: row.exceptionDate,
        })
      }
      exceptions.push({
        date: dateResult.value,
        slots: row.exceptionSlots,
        note: row.exceptionNote,
      })
    }

    // Build periods with validated dates
    const periods: CalendarPeriod[] = []
    for (const row of data.periods) {
      const startDateResult = DateTime.make(row.periodStart)
      if (startDateResult._tag === "None") {
        return yield* new InvalidCalendarDataError({
          message: `Invalid period start date: ${row.periodStart}`,
          orgUnitId: data.orgUnitId,
          field: `periods.${row.periodTitle}.periodStart`,
          value: row.periodStart,
        })
      }
      const endDateResult = DateTime.make(row.periodEnd)
      if (endDateResult._tag === "None") {
        return yield* new InvalidCalendarDataError({
          message: `Invalid period end date: ${row.periodEnd}`,
          orgUnitId: data.orgUnitId,
          field: `periods.${row.periodTitle}.periodEnd`,
          value: row.periodEnd,
        })
      }
      const validatedSchedule = yield* validatePeriodSchedule(
        row.periodSchedule,
        data.orgUnitId,
        row.periodTitle,
      )
      periods.push({
        id: `${row.orgUnitId}-${row.periodKind}-${row.periodTitle}`,
        name: row.periodTitle,
        type: row.periodKind,
        startDate: startDateResult.value,
        endDate: endDateResult.value,
        isActive: row.periodActive,
        weeklySchedule: validatedSchedule,
      })
    }

    // Determine non-working days from absence in weekly schedule
    const workDays = new Set(weeklySchedule.map((s) => s.day))
    const nonWorkingDays: DayOfWeek[] = []
    for (let i = 0; i <= 6; i++) {
      if (!workDays.has(i as DayOfWeek)) {
        nonWorkingDays.push(i as DayOfWeek)
      }
    }

    return {
      weeklySchedule,
      holidays,
      exceptions,
      nonWorkingDays,
      periods,
      timezone: data.timezone,
    }
  })
