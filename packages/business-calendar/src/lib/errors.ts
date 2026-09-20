import { Data } from "effect"

/**
 * Error thrown when a date is outside the valid range for calendar operations.
 */
export class DateOutOfRangeError extends Data.TaggedError(
  "DateOutOfRangeError",
)<{
  readonly date: string
  readonly message: string
}> {}

/**
 * Error thrown when no business hours are configured for a calendar.
 */
export class NoBusinessHoursError extends Data.TaggedError(
  "NoBusinessHoursError",
)<{
  readonly message: string
}> {}

/**
 * Error thrown when calendar configuration is invalid.
 */
export class InvalidCalendarConfigError extends Data.TaggedError(
  "InvalidCalendarConfigError",
)<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Error thrown when a date combination is invalid (e.g., Feb 30).
 */
export class InvalidDateError extends Data.TaggedError("InvalidDateError")<{
  readonly year: number
  readonly month: number
  readonly day: number
  readonly message: string
}> {}

/**
 * Error thrown when a year is outside the supported range.
 * Easter calculation is only valid for Gregorian calendar (year >= 1583).
 */
export class InvalidYearError extends Data.TaggedError("InvalidYearError")<{
  readonly year: number
  readonly message: string
}> {}

/**
 * Error thrown when branded type validation fails.
 */
export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly message: string
  readonly cause?: unknown
}> {}
