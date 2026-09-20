import type { SqlError } from "@effect/sql/SqlError"
import { Context, type Effect } from "effect"

/**
 * Time of day (hour 0-23, minute 0-59).
 * Matches @pf/business-calendar TimeOfDay.
 */
export interface TimeOfDay {
  hour: number
  minute: number
}

/**
 * A time range within a day.
 * Matches @pf/business-calendar TimeRange.
 */
export interface TimeRange {
  open: TimeOfDay
  close: TimeOfDay
}

/**
 * Weekly schedule entry from the database.
 */
export interface WeeklyScheduleRow {
  orgUnitId: string
  /** Day of week (0 = Sunday, 6 = Saturday) */
  dayOfWeek: number
  timeRanges: TimeRange[]
}

/**
 * Date exception entry from the database.
 */
export interface DateExceptionRow {
  orgUnitId: string
  /** Date as epoch milliseconds (start of day in UTC) */
  exceptionDate: number
  /** Time ranges for this date, or "closed" */
  exceptionSlots: TimeRange[] | "closed"
  exceptionNote?: string
}

/**
 * Holiday instance entry from the database.
 */
export interface HolidayInstanceRow {
  orgUnitId: string
  holidayTitle: string
  /** Holiday rule as JSON - the Holiday union type */
  holidayRule: unknown
  /** Pre-computed date as epoch milliseconds, if available */
  holidayDate?: number
}

/**
 * Calendar period entry from the database.
 */
export interface CalendarPeriodRow {
  orgUnitId: string
  periodKind: string
  periodTitle: string
  /** Start date as epoch milliseconds */
  periodStart: number
  /** End date as epoch milliseconds */
  periodEnd: number
  periodActive: boolean
  /** Optional schedule override for this period */
  periodSchedule?: unknown
}

/**
 * Complete calendar data for an org unit.
 */
export interface OrgUnitCalendarData {
  orgUnitId: string
  /** IANA timezone identifier (e.g., "Pacific/Auckland"). Defaults to "UTC" if not set. */
  timezone: string
  weeklySchedule: WeeklyScheduleRow[]
  dateExceptions: DateExceptionRow[]
  holidays: HolidayInstanceRow[]
  periods: CalendarPeriodRow[]
}

/**
 * Service for querying business calendar configuration from the database.
 */
export class BusinessCalendarQueries extends Context.Tag(
  "@pf/graphql-db-operations/BusinessCalendarQueries",
)<
  BusinessCalendarQueries,
  {
    /**
     * Get calendar data for one or more org units.
     * Returns all calendar-related data needed to construct BusinessCalendarConfig.
     *
     * @param orgUnitIds - Org unit IDs to fetch calendar data for
     * @returns Map of org unit ID to calendar data
     */
    readonly getCalendarData: (
      orgUnitIds: string[],
    ) => Effect.Effect<Map<string, OrgUnitCalendarData>, SqlError>

    /**
     * Get the root org unit (the one with no parent).
     * Used to find the organisation-level calendar for fallback.
     *
     * @returns The ID of the root org unit, or null if not found
     */
    readonly getRootOrgUnit: () => Effect.Effect<string | null, SqlError>
  }
>() {}
