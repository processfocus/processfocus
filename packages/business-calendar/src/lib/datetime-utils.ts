import { DateTime } from "effect"

/**
 * Create a DateTime.Utc for a specific date and time.
 *
 * Note: DateTime.unsafeMake with object params sets time components to 0,
 * so we use mutate to set the desired time.
 *
 * @param year - Year (e.g., 2025)
 * @param month - Month (1-12)
 * @param day - Day of month (1-31)
 * @param hour - Hour (0-23), defaults to 0
 * @param minute - Minute (0-59), defaults to 0
 * @returns DateTime.Utc at the specified date and time
 */
export const makeDateTimeWithTime = (
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): DateTime.Utc => {
  const base = DateTime.unsafeMake({ year, month, day })
  return DateTime.mutate(base, (d) => {
    d.setUTCHours(hour)
    d.setUTCMinutes(minute)
    d.setUTCSeconds(0)
    d.setUTCMilliseconds(0)
  })
}

/**
 * Get a DateTime.Utc at the start of the day (00:00:00.000).
 *
 * @param date - The source DateTime
 * @returns DateTime.Utc at midnight of the same date
 */
export const startOfDay = (date: DateTime.Utc): DateTime.Utc => {
  const parts = DateTime.toParts(date)
  return DateTime.unsafeMake({
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: 0,
    minute: 0,
    second: 0,
    millis: 0,
  })
}

/**
 * Check if two DateTime.Utc values represent the same calendar date.
 *
 * @param a - First DateTime
 * @param b - Second DateTime
 * @returns true if same year, month, and day
 */
export const isSameDate = (a: DateTime.Utc, b: DateTime.Utc): boolean => {
  const aParts = DateTime.toParts(a)
  const bParts = DateTime.toParts(b)
  return (
    aParts.year === bParts.year &&
    aParts.month === bParts.month &&
    aParts.day === bParts.day
  )
}
