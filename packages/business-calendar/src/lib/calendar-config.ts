import { Schema } from "effect"
import { CalendarPeriod } from "./calendar-period.js"
import { Holiday } from "./holidays.js"
import {
  DayOfWeek,
  DaySchedule,
  Friday,
  Monday,
  Saturday,
  Sunday,
  Thursday,
  TimeRange,
  Tuesday,
  Wednesday,
} from "./types.js"

/**
 * Date exception: one-off override for a specific date.
 * Takes precedence over holidays and periods.
 *
 * @property slots - Time ranges for this date, or "closed" to mark as non-working
 * @property note - Optional human-readable note (e.g., "Early closing for staff party")
 */
export const DateException = Schema.Struct({
  date: Schema.DateTimeUtcFromSelf,
  slots: Schema.Union(Schema.Array(TimeRange), Schema.Literal("closed")),
  note: Schema.optional(Schema.String),
})
export type DateException = typeof DateException.Type

/**
 * Schema for encoding DateException to JSON (for database storage).
 */
export const DateExceptionFromJson = Schema.Struct({
  date: Schema.DateTimeUtc,
  slots: Schema.Union(Schema.Array(TimeRange), Schema.Literal("closed")),
  note: Schema.optional(Schema.String),
})
export type DateExceptionFromJson = typeof DateExceptionFromJson.Type

/**
 * Complete business calendar configuration.
 * Combines weekly schedule, holidays, exceptions, and periods.
 *
 * Note: Timezone is stored at the Organisation/OrgUnit level, not here.
 * The calendar service receives timezone from context.
 */
export const BusinessCalendarConfig = Schema.Struct({
  /**
   * Default weekly schedule.
   * Days without entries are considered non-working.
   */
  weeklySchedule: Schema.Array(DaySchedule),

  /**
   * Holiday rules (fixed, nth weekday, Easter-relative, etc.).
   * Holidays are computed for each year as needed.
   */
  holidays: Schema.Array(Holiday),

  /**
   * One-off date overrides.
   * Take precedence over holidays and periods.
   */
  exceptions: Schema.Array(DateException),

  /**
   * Days of week that are non-working (0 = Sunday, 6 = Saturday).
   * Typically [0, 6] for weekends.
   */
  nonWorkingDays: Schema.Array(DayOfWeek),

  /**
   * Calendar periods loaded from database.
   * Used for terms, seasons, fiscal periods, etc.
   */
  periods: Schema.Array(CalendarPeriod),

  /**
   * If set, dates outside any active period of this type are non-business days.
   * Example: "school_term" - only dates within active school terms are business days.
   */
  requireActivePeriod: Schema.optional(Schema.String),

  /**
   * First day of the business week (0 = Sunday, 6 = Saturday).
   * Defaults to Sunday (0).
   */
  startDayOfWeek: Schema.optional(DayOfWeek),

  /**
   * IANA timezone identifier for the calendar (e.g., "Pacific/Auckland", "America/New_York").
   * Schedule times are interpreted in this timezone.
   * Defaults to "UTC" if not specified.
   */
  timezone: Schema.optional(Schema.String),
})
export type BusinessCalendarConfig = typeof BusinessCalendarConfig.Type

// Helper to create a standard weekday schedule (Mon-Fri, 9-5)

/**
 * Creates a standard Monday-Friday 9:00-17:00 schedule.
 */
export const createStandardWeekdaySchedule = (): DaySchedule[] => [
  {
    day: Monday,
    ranges: [{ open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } }],
  },
  {
    day: Tuesday,
    ranges: [{ open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } }],
  },
  {
    day: Wednesday,
    ranges: [{ open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } }],
  },
  {
    day: Thursday,
    ranges: [{ open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } }],
  },
  {
    day: Friday,
    ranges: [{ open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } }],
  },
]

/**
 * Creates a default business calendar with standard hours.
 */
export const createDefaultConfig = (
  holidays: Holiday[] = [],
): BusinessCalendarConfig => ({
  weeklySchedule: createStandardWeekdaySchedule(),
  holidays,
  exceptions: [],
  nonWorkingDays: [Saturday, Sunday],
  periods: [],
  startDayOfWeek: Sunday,
})
