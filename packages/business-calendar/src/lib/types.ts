import { Schema } from "effect"

/**
 * Day of week (0 = Sunday, 6 = Saturday).
 * Matches JavaScript Date.getDay() convention.
 */
export const DayOfWeek = Schema.Int.pipe(
  Schema.between(0, 6),
  Schema.brand("DayOfWeek"),
)
export type DayOfWeek = typeof DayOfWeek.Type

/** Named weekday constants */
export const Sunday = 0 as DayOfWeek
export const Monday = 1 as DayOfWeek
export const Tuesday = 2 as DayOfWeek
export const Wednesday = 3 as DayOfWeek
export const Thursday = 4 as DayOfWeek
export const Friday = 5 as DayOfWeek
export const Saturday = 6 as DayOfWeek

/** Array of weekdays (Mon-Fri) for convenience */
export const Weekdays: readonly DayOfWeek[] = [
  Monday,
  Tuesday,
  Wednesday,
  Thursday,
  Friday,
]

/** Array of all days (Sun-Sat) for iteration */
export const AllDays: readonly DayOfWeek[] = [
  Sunday,
  Monday,
  Tuesday,
  Wednesday,
  Thursday,
  Friday,
  Saturday,
]

/**
 * Time of day with hour (0-23) and minute (0-59).
 */
export const TimeOfDay = Schema.Struct({
  hour: Schema.Int.pipe(Schema.between(0, 23)),
  minute: Schema.Int.pipe(Schema.between(0, 59)),
})
export type TimeOfDay = typeof TimeOfDay.Type

/**
 * A time range within a day.
 * Supports overnight ranges: if close < open, the range spans midnight.
 * Example: { open: { hour: 22, minute: 0 }, close: { hour: 6, minute: 0 } }
 * represents 10 PM to 6 AM the next day.
 */
export const TimeRange = Schema.Struct({
  open: TimeOfDay,
  close: TimeOfDay,
})
export type TimeRange = typeof TimeRange.Type

/**
 * Schedule for a specific day of the week.
 * Contains multiple time ranges to support split shifts (e.g., 9-12, 13-17).
 */
export const DaySchedule = Schema.Struct({
  day: DayOfWeek,
  ranges: Schema.Array(TimeRange),
})
export type DaySchedule = typeof DaySchedule.Type

/**
 * Weekly schedule as an array of day schedules.
 * Days without entries are considered non-working.
 */
export const WeeklySchedule = Schema.Array(DaySchedule)
export type WeeklySchedule = typeof WeeklySchedule.Type

/**
 * Month number (1-12).
 */
export const Month = Schema.Int.pipe(
  Schema.between(1, 12),
  Schema.brand("Month"),
)
export type Month = typeof Month.Type

/**
 * Day of month (1-31).
 * Note: validation doesn't check for valid days per month (e.g., Feb 30).
 * That validation happens at calculation time.
 */
export const DayOfMonth = Schema.Int.pipe(
  Schema.between(1, 31),
  Schema.brand("DayOfMonth"),
)
export type DayOfMonth = typeof DayOfMonth.Type

/**
 * Nth occurrence (1-5, where 5 means "last" in some contexts).
 */
export const NthOccurrence = Schema.Int.pipe(
  Schema.between(1, 5),
  Schema.brand("NthOccurrence"),
)
export type NthOccurrence = typeof NthOccurrence.Type

/**
 * Convert TimeOfDay to minutes since midnight.
 */
export const timeOfDayToMinutes = (time: TimeOfDay): number =>
  time.hour * 60 + time.minute

/**
 * Check if a TimeRange spans overnight (close time is before open time).
 */
export const isOvernightRange = (range: TimeRange): boolean =>
  timeOfDayToMinutes(range.close) < timeOfDayToMinutes(range.open)

/**
 * Calculate the duration of a TimeRange in minutes.
 * Handles overnight ranges correctly.
 */
export const timeRangeDurationMinutes = (range: TimeRange): number => {
  const openMinutes = timeOfDayToMinutes(range.open)
  const closeMinutes = timeOfDayToMinutes(range.close)

  if (closeMinutes >= openMinutes) {
    return closeMinutes - openMinutes
  }
  // Overnight range: minutes until midnight + minutes after midnight
  return 24 * 60 - openMinutes + closeMinutes
}
