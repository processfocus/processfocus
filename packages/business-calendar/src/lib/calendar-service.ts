import {
  Context,
  Data,
  type DateTime,
  type Duration,
  type Effect,
  type Option,
} from "effect"
import type { BusinessCalendarConfig } from "./calendar-config.js"
import type { CalendarPeriod } from "./calendar-period.js"
import type { HolidayInstance } from "./holidays.js"
import type { DaySchedule } from "./types.js"

/**
 * Error thrown when business calendar operations fail.
 */
export class BusinessCalendarError extends Data.TaggedError(
  "BusinessCalendarError",
)<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Service interface for business calendar operations.
 */
export interface BusinessCalendarServiceShape {
  /**
   * Check if a date is a business day.
   * A business day is a day that is:
   * - Not a weekend (as defined by nonWorkingDays)
   * - Not a holiday
   * - Within an active period (if requireActivePeriod is set)
   * - Not marked as "closed" by an exception
   */
  readonly isBusinessDay: (
    date: DateTime.Utc,
  ) => Effect.Effect<boolean, never, never>

  /**
   * Check if a datetime falls within business hours.
   * Considers the effective schedule (exceptions > periods > default).
   */
  readonly isBusinessHours: (
    datetime: DateTime.Utc,
  ) => Effect.Effect<boolean, never, never>

  /**
   * Add a number of business days to a date.
   * Skips weekends, holidays, and inactive periods.
   * Does not fail when the search budget is exhausted; returns the last date
   * reached under the internal iteration limit.
   *
   * @param date - Starting date
   * @param days - Number of business days to add (can be negative)
   */
  readonly addBusinessDays: (
    date: DateTime.Utc,
    days: number,
  ) => Effect.Effect<DateTime.Utc, never, never>

  /**
   * Add a number of business hours to a datetime.
   * Only counts time during business hours.
   *
   * Fails with `BusinessCalendarError` if no business day found within search limit
   *
   * @param datetime - Starting datetime
   * @param hours - Number of business hours to add (must be positive)
   */
  readonly addBusinessHours: (
    datetime: DateTime.Utc,
    hours: number,
  ) => Effect.Effect<DateTime.Utc, BusinessCalendarError, never>

  /**
   * Get the next business day after a given date.
   * If the given date is a business day, returns the next one.
   *
   * Fails with `BusinessCalendarError` if no business day found within search limit
   */
  readonly nextBusinessDay: (
    date: DateTime.Utc,
  ) => Effect.Effect<DateTime.Utc, BusinessCalendarError, never>

  /**
   * Get the previous business day before a given date.
   * If the given date is a business day, returns the previous one.
   *
   * Fails with `BusinessCalendarError` if no business day found within search limit
   */
  readonly previousBusinessDay: (
    date: DateTime.Utc,
  ) => Effect.Effect<DateTime.Utc, BusinessCalendarError, never>

  /**
   * Get the start time of business hours for a given date.
   * Returns None if the date is not a business day.
   */
  readonly businessDayStart: (
    date: DateTime.Utc,
  ) => Effect.Effect<Option.Option<DateTime.Utc>, never, never>

  /**
   * Get the end time of business hours for a given date.
   * Returns None if the date is not a business day.
   */
  readonly businessDayEnd: (
    date: DateTime.Utc,
  ) => Effect.Effect<Option.Option<DateTime.Utc>, never, never>

  /**
   * Get remaining business hours from a datetime until end of business day.
   * Returns zero if outside business hours or on a non-business day.
   */
  readonly businessHoursRemaining: (
    datetime: DateTime.Utc,
  ) => Effect.Effect<Duration.Duration, never, never>

  /**
   * Count business days between two dates (exclusive of end date).
   */
  readonly businessDaysBetween: (
    start: DateTime.Utc,
    end: DateTime.Utc,
  ) => Effect.Effect<number, never, never>

  /**
   * Calculate business hours between two datetimes.
   * Only counts time during business hours on business days.
   */
  readonly businessHoursBetween: (
    start: DateTime.Utc,
    end: DateTime.Utc,
  ) => Effect.Effect<Duration.Duration, BusinessCalendarError, never>

  /**
   * Check if a date is a holiday.
   */
  readonly isHoliday: (
    date: DateTime.Utc,
  ) => Effect.Effect<boolean, never, never>

  /**
   * Get all holidays for a year.
   *
   * Calculation failures are logged and degrade to an empty list (never fail
   * the typed error channel). Callers cannot distinguish "no holidays
   * configured" from "calculation failed". Interruptions still propagate and
   * are not cached as a successful empty year.
   */
  readonly getHolidaysForYear: (
    year: number,
  ) => Effect.Effect<HolidayInstance[], never, never>

  /**
   * Get all active periods for a date.
   */
  readonly getActivePeriods: (
    date: DateTime.Utc,
  ) => Effect.Effect<CalendarPeriod[], never, never>

  /**
   * Get active periods of a specific type for a date.
   */
  readonly getActivePeriodsByType: (
    date: DateTime.Utc,
    type: string,
  ) => Effect.Effect<CalendarPeriod[], never, never>

  /**
   * Check if a date is within any period of a specific type.
   */
  readonly isWithinPeriodType: (
    date: DateTime.Utc,
    type: string,
  ) => Effect.Effect<boolean, never, never>

  /**
   * Get all periods that overlap with a date range.
   * Optionally filter by period type.
   */
  readonly getPeriodsForDateRange: (
    start: DateTime.Utc,
    end: DateTime.Utc,
    type?: string,
  ) => Effect.Effect<CalendarPeriod[], never, never>

  /**
   * Get the effective schedule for a date.
   * Priority: exceptions > period overrides > default weekly schedule.
   */
  readonly getEffectiveSchedule: (
    date: DateTime.Utc,
  ) => Effect.Effect<DaySchedule[], never, never>
}

/**
 * Business Calendar Service tag.
 */
export class BusinessCalendarService extends Context.Tag(
  "@pf/business-calendar/BusinessCalendarService",
)<BusinessCalendarService, BusinessCalendarServiceShape>() {}

/**
 * Business Calendar Config Service tag.
 * Used to provide the configuration to the service implementation.
 */
export class BusinessCalendarConfigService extends Context.Tag(
  "@pf/business-calendar/BusinessCalendarConfigService",
)<BusinessCalendarConfigService, BusinessCalendarConfig>() {}
