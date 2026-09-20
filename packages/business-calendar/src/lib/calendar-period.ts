import { Schema } from "effect"
import { DaySchedule } from "./types.js"

/**
 * A calendar period represents a date range with specific characteristics.
 * Used for school terms, seasonal schedules, fiscal periods, etc.
 *
 * When `requireActivePeriod` is set on a calendar config, dates outside
 * any active period of that type are considered non-business days.
 *
 * Examples:
 * - School terms: { type: "school_term", name: "Term 1", isActive: true }
 * - Shop hours: { type: "shop_season", name: "Christmas Extended", weeklySchedule: [...] }
 * - Company schedule: { type: "fiscal_quarter", name: "Q1 2026", isActive: true }
 */
export const CalendarPeriod = Schema.Struct({
  /**
   * Unique identifier for the period.
   */
  id: Schema.String,

  /**
   * Type categorizes periods (e.g., "school_term", "shop_season", "fiscal_quarter").
   * Used with `requireActivePeriod` to filter relevant periods.
   */
  type: Schema.String,

  /**
   * Human-readable name (e.g., "Term 1", "Christmas Extended", "Q1 2026").
   */
  name: Schema.String,

  /**
   * Start date of the period (inclusive).
   * Stored as ISO 8601 date string for serialization.
   */
  startDate: Schema.DateTimeUtcFromSelf,

  /**
   * End date of the period (inclusive).
   * Stored as ISO 8601 date string for serialization.
   */
  endDate: Schema.DateTimeUtcFromSelf,

  /**
   * Whether this period counts as "active" or "working".
   * When requireActivePeriod is set, only dates within active periods
   * of that type are considered business days.
   */
  isActive: Schema.Boolean,

  /**
   * Optional weekly schedule override during this period.
   * If provided, these hours replace the default calendar hours.
   * Useful for extended hours, reduced hours, or different patterns.
   */
  weeklySchedule: Schema.optional(Schema.Array(DaySchedule)),
})
export type CalendarPeriod = typeof CalendarPeriod.Type

/**
 * Schema for encoding CalendarPeriod to JSON (for database storage).
 */
export const CalendarPeriodFromJson = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  name: Schema.String,
  startDate: Schema.DateTimeUtc,
  endDate: Schema.DateTimeUtc,
  isActive: Schema.Boolean,
  weeklySchedule: Schema.optional(Schema.Array(DaySchedule)),
})
export type CalendarPeriodFromJson = typeof CalendarPeriodFromJson.Type
