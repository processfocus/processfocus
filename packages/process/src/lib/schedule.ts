/**
 * Schedule types for business-calendar-aware scheduling.
 *
 * Schedule functions in `flow.next()` can return either:
 * - A raw `DateTime.DateTime` (backward compatible, wall-clock time)
 * - A marker type from this module that gets resolved at execution time
 *
 * Business-time markers are resolved in the job-handler using the
 * BusinessCalendarService from `@pf/business-calendar`.
 *
 * @example
 * ```typescript
 * import { Schedule } from "@pf/process"
 *
 * flow.next(reviewStep, {
 *   schedule: {
 *     fn: (_state, ctx) => Schedule.businessHours(
 *       ctx.step.submitRequest.completedAt,
 *       1  // 1 business hour
 *     ),
 *     text: "1 business hour after submission",
 *   },
 * })
 *
 * // Also available:
 * // Schedule.businessDays(from, days) - business days
 * // Schedule.clockTime(from, duration) - explicit wall-clock time
 * ```
 */

import { type DateTime, Duration } from "effect"

/**
 * Marker type for scheduling based on business minutes.
 * Resolved at execution time using BusinessCalendarService.addBusinessMinutes().
 */
export interface BusinessMinutesSchedule {
  readonly _tag: "BusinessMinutes"
  /** Starting point for the calculation */
  readonly from: DateTime.DateTime
  /** Number of business minutes to add */
  readonly minutes: number
}

/**
 * Marker type for scheduling based on business hours.
 * Resolved at execution time using BusinessCalendarService.addBusinessHours().
 */
export interface BusinessHoursSchedule {
  readonly _tag: "BusinessHours"
  /** Starting point for the calculation */
  readonly from: DateTime.DateTime
  /** Number of business hours to add (can be fractional) */
  readonly hours: number
}

/**
 * Marker type for scheduling based on business days.
 * Resolved at execution time using BusinessCalendarService.addBusinessDays().
 */
export interface BusinessDaysSchedule {
  readonly _tag: "BusinessDays"
  /** Starting point for the calculation */
  readonly from: DateTime.DateTime
  /** Number of business days to add */
  readonly days: number
}

/**
 * Marker type for explicit wall-clock time scheduling.
 * Provides a way to explicitly opt-in to clock time (instead of relying on
 * raw DateTime return type which is also clock time but less explicit).
 */
export interface ClockTimeSchedule {
  readonly _tag: "ClockTime"
  /** Starting point for the calculation */
  readonly from: DateTime.DateTime
  /** Duration to add */
  readonly duration: Duration.Duration
}

/**
 * Marker type for scheduling based on a reference point with calendar offset.
 * Computes a calendar offset from a reference date and snaps the result to the
 * nearest business day/hours. The snap direction matches the offset sign:
 * negative offsets snap backward, positive snap forward.
 *
 * Edge case: Zero offset ({ days: 0 }) on a non-business day snaps forward
 * to the next business day (same as positive offsets). This ensures scheduling
 * always occurs on a valid business day.
 *
 * @example
 * ```typescript
 * // Schedule 1 week before start date, snapping to previous business day
 * Schedule.fromPoint(state.start_date, { days: -7 })
 * // If result lands on a weekend/holiday, snaps backward to the previous business day
 *
 * // Schedule on the reference date itself (snaps to next business day if weekend)
 * Schedule.fromPoint(state.start_date, { days: 0 })
 * // Saturday Feb 14 → snaps forward to Monday Feb 16
 * ```
 */
export interface FromPointSchedule {
  readonly _tag: "FromPoint"
  /** Starting point for the calculation */
  readonly from: DateTime.DateTime
  /** Calendar offset to apply (can be negative). Zero offset on non-business days snaps forward. */
  readonly offset: { days?: number; hours?: number; minutes?: number }
}

/**
 * Union type of all schedule marker types.
 * Used internally to identify business-time schedules.
 */
export type ScheduleMarker =
  | BusinessMinutesSchedule
  | BusinessHoursSchedule
  | BusinessDaysSchedule
  | ClockTimeSchedule
  | FromPointSchedule

/**
 * All possible return types from a schedule function.
 * - Raw `DateTime.DateTime` for backward compatibility (wall-clock time)
 * - Marker types for business-calendar-aware scheduling
 */
export type ScheduledTime = DateTime.DateTime | ScheduleMarker

/**
 * Schedule helper functions for creating schedule marker types.
 *
 * @example
 * ```typescript
 * import { Schedule } from "@pf/process"
 * import { Duration } from "effect"
 *
 * // Schedule 2 business hours after step completion
 * Schedule.businessHours(ctx.step.submitRequest.completedAt, 2)
 *
 * // Schedule 3 business days after step completion
 * Schedule.businessDays(ctx.step.submitRequest.completedAt, 3)
 *
 * // Explicit clock time (for when you want wall-clock, not business time)
 * Schedule.clockTime(ctx.step.submitRequest.completedAt, "1 hour")
 * Schedule.clockTime(ctx.step.submitRequest.completedAt, Duration.hours(1))
 * ```
 */
export const Schedule = {
  /**
   * Create a business minutes schedule marker.
   *
   * @param from - Starting datetime
   * @param minutes - Number of business minutes to add
   * @returns A BusinessMinutesSchedule marker resolved at execution time
   */
  businessMinutes(
    from: DateTime.DateTime,
    minutes: number,
  ): BusinessMinutesSchedule {
    if (minutes < 0) {
      throw new Error(
        `Schedule.businessMinutes: minutes must be non-negative, got ${minutes}`,
      )
    }
    return {
      _tag: "BusinessMinutes",
      from,
      minutes,
    }
  },

  /**
   * Create a business hours schedule marker.
   *
   * @param from - Starting datetime
   * @param hours - Number of business hours to add (can be fractional, e.g., 1.5)
   * @returns A BusinessHoursSchedule marker resolved at execution time
   */
  businessHours(from: DateTime.DateTime, hours: number): BusinessHoursSchedule {
    if (hours < 0) {
      throw new Error(
        `Schedule.businessHours: hours must be non-negative, got ${hours}`,
      )
    }
    return {
      _tag: "BusinessHours",
      from,
      hours,
    }
  },

  /**
   * Create a business days schedule marker.
   *
   * @param from - Starting datetime
   * @param days - Number of business days to add
   * @returns A BusinessDaysSchedule marker resolved at execution time
   */
  businessDays(from: DateTime.DateTime, days: number): BusinessDaysSchedule {
    if (days < 0) {
      throw new Error(
        `Schedule.businessDays: days must be non-negative, got ${days}`,
      )
    }
    return {
      _tag: "BusinessDays",
      from,
      days,
    }
  },

  /**
   * Create a clock time schedule marker.
   *
   * Unlike returning a raw DateTime (which bypasses resolution entirely),
   * this returns a marker that explicitly signals clock-time semantics
   * during resolution. Use this when you want to clearly indicate that
   * a schedule should use wall-clock time, not business time.
   *
   * @param from - Starting datetime
   * @param duration - Duration to add (DurationInput accepts string like "1 hour")
   * @returns A ClockTimeSchedule marker resolved at execution time
   */
  clockTime(
    from: DateTime.DateTime,
    duration: Duration.DurationInput,
  ): ClockTimeSchedule {
    return {
      _tag: "ClockTime",
      from,
      duration: Duration.decode(duration),
    }
  },

  /**
   * Create a from-point schedule marker.
   *
   * Computes a calendar offset from a reference date and snaps the result to
   * the nearest business day/hours. The snap direction matches the offset sign:
   * negative offsets snap backward, positive snap forward.
   *
   * Edge case: Zero offset on a non-business day (weekend/holiday) snaps forward
   * to the next business day, ensuring the schedule always lands on a valid
   * business day.
   *
   * @example
   * ```typescript
   * // Schedule 1 week before start date
   * Schedule.fromPoint(state.start_date, { days: -7 })
   * // If Feb 17 - 7 days = Feb 10 (closed), snaps backward to Feb 9
   *
   * // Schedule on the reference date itself
   * Schedule.fromPoint(state.start_date, { days: 0 })
   * // If start_date is Saturday, snaps to following Monday
   * ```
   *
   * @param from - Starting datetime (reference point)
   * @param offset - Calendar offset to apply (can have negative values). Zero on non-business days snaps forward.
   * @returns A FromPointSchedule marker resolved at execution time
   */
  fromPoint(
    from: DateTime.DateTime,
    offset: { days?: number; hours?: number; minutes?: number },
  ): FromPointSchedule {
    return {
      _tag: "FromPoint",
      from,
      offset,
    }
  },

  /**
   * Type guard to check if a value is a schedule marker (not a raw DateTime).
   *
   * @param value - Value to check
   * @returns True if value is a ScheduleMarker
   */
  isScheduleMarker(value: unknown): value is ScheduleMarker {
    return (
      typeof value === "object" &&
      value !== null &&
      "_tag" in value &&
      (value._tag === "BusinessMinutes" ||
        value._tag === "BusinessHours" ||
        value._tag === "BusinessDays" ||
        value._tag === "ClockTime" ||
        value._tag === "FromPoint")
    )
  },

  /**
   * Pattern match on a ScheduleMarker, similar to Effect's Option.match/Either.match.
   *
   * @param marker - The schedule marker to match on
   * @param handlers - Object with handler functions for each marker type
   * @returns The result of the matching handler
   *
   * @example
   * ```typescript
   * Schedule.match(marker, {
   *   onBusinessMinutes: (m) => `${m.minutes} business minutes`,
   *   onBusinessHours: (m) => `${m.hours} business hours`,
   *   onBusinessDays: (m) => `${m.days} business days`,
   *   onClockTime: (m) => `clock time duration`,
   *   onFromPoint: (m) => `from ${m.from} with offset`,
   * })
   * ```
   */
  match<A, B, C, D, E>(
    marker: ScheduleMarker,
    handlers: {
      onBusinessMinutes: (marker: BusinessMinutesSchedule) => A
      onBusinessHours: (marker: BusinessHoursSchedule) => B
      onBusinessDays: (marker: BusinessDaysSchedule) => C
      onClockTime: (marker: ClockTimeSchedule) => D
      onFromPoint: (marker: FromPointSchedule) => E
    },
  ): A | B | C | D | E {
    switch (marker._tag) {
      case "BusinessMinutes":
        return handlers.onBusinessMinutes(marker)
      case "BusinessHours":
        return handlers.onBusinessHours(marker)
      case "BusinessDays":
        return handlers.onBusinessDays(marker)
      case "ClockTime":
        return handlers.onClockTime(marker)
      case "FromPoint":
        return handlers.onFromPoint(marker)
    }
  },
}
