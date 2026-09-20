import { DateTime, Effect } from "effect"
import { InvalidDateError, InvalidYearError } from "./errors.js"
import type {
  EasterRelativeHoliday,
  FixedHoliday,
  Holiday,
  HolidayInstance,
  LastWeekdayHoliday,
  NthWeekdayHoliday,
} from "./holidays.js"
import type { DayOfWeek, Month } from "./types.js"

/** Minimum year for Easter calculation (Gregorian calendar) */
const MIN_EASTER_YEAR = 1583

/** Maximum year for reasonable calendar operations */
const MAX_YEAR = 9999

/**
 * Validate that a year is within the supported range.
 */
const validateYear = (
  year: number,
): Effect.Effect<number, InvalidYearError> => {
  if (!Number.isInteger(year)) {
    return Effect.fail(
      new InvalidYearError({
        year,
        message: `Year must be an integer, got ${year}`,
      }),
    )
  }
  if (year < MIN_EASTER_YEAR) {
    return Effect.fail(
      new InvalidYearError({
        year,
        message: `Year must be >= ${MIN_EASTER_YEAR} for Gregorian calendar, got ${year}`,
      }),
    )
  }
  if (year > MAX_YEAR) {
    return Effect.fail(
      new InvalidYearError({
        year,
        message: `Year must be <= ${MAX_YEAR}, got ${year}`,
      }),
    )
  }
  return Effect.succeed(year)
}

/**
 * Get the number of days in a month for a given year.
 */
const daysInMonth = (year: number, month: number): number => {
  // Month is 1-indexed, Date constructor expects 0-indexed
  // Using day 0 of next month gives last day of current month
  return new Date(year, month, 0).getDate()
}

/**
 * Validate that a date combination is valid.
 */
const validateDate = (
  year: number,
  month: number,
  day: number,
): Effect.Effect<void, InvalidDateError> => {
  const maxDay = daysInMonth(year, month)
  if (day > maxDay) {
    return Effect.fail(
      new InvalidDateError({
        year,
        month,
        day,
        message: `Invalid date: ${year}-${month}-${day}. Month ${month} has only ${maxDay} days in year ${year}`,
      }),
    )
  }
  return Effect.void
}

/**
 * Safely create a DateTime.Utc, wrapping potential errors.
 */
const safeDateTime = (
  year: number,
  month: number,
  day: number,
): Effect.Effect<DateTime.Utc, InvalidDateError> =>
  Effect.try({
    try: () =>
      DateTime.unsafeMake({
        year,
        month,
        day,
        hour: 0,
        minute: 0,
        second: 0,
        millis: 0,
      }),
    catch: (error) =>
      new InvalidDateError({
        year,
        month,
        day,
        message: `Failed to create date: ${error}`,
      }),
  })

/**
 * Calculate Easter Sunday for a given year using the Anonymous Gregorian algorithm.
 * This is the "Meeus/Jones/Butcher" algorithm.
 *
 * @see https://en.wikipedia.org/wiki/Date_of_Easter#Anonymous_Gregorian_algorithm
 */
export const calculateEasterSunday = (
  year: number,
): Effect.Effect<DateTime.Utc, InvalidYearError | InvalidDateError> =>
  Effect.gen(function* () {
    yield* validateYear(year)

    const a = year % 19
    const b = Math.floor(year / 100)
    const c = year % 100
    const d = Math.floor(b / 4)
    const e = b % 4
    const f = Math.floor((b + 8) / 25)
    const g = Math.floor((b - f + 1) / 3)
    const h = (19 * a + b - d - g + 15) % 30
    const i = Math.floor(c / 4)
    const k = c % 4
    const l = (32 + 2 * e + 2 * i - h - k) % 7
    const m = Math.floor((a + 11 * h + 22 * l) / 451)
    const month = Math.floor((h + l - 7 * m + 114) / 31)
    const day = ((h + l - 7 * m + 114) % 31) + 1

    return yield* safeDateTime(year, month, day)
  })

/**
 * Get the nth occurrence of a weekday in a month.
 *
 * @param year - The year
 * @param month - The month (1-12)
 * @param weekday - The day of week (0 = Sunday, 6 = Saturday)
 * @param nth - Which occurrence (1-5)
 * @returns The date, or undefined if nth occurrence doesn't exist
 */
export const getNthWeekdayOfMonth = (
  year: number,
  month: Month,
  weekday: DayOfWeek,
  nth: number,
): Effect.Effect<
  DateTime.Utc | undefined,
  InvalidYearError | InvalidDateError
> =>
  Effect.gen(function* () {
    yield* validateYear(year)

    // Start at the first day of the month
    let date = yield* safeDateTime(year, month, 1)

    // Find the first occurrence of the weekday
    const parts = DateTime.toParts(date)
    const currentWeekday = parts.weekDay
    let daysUntilWeekday = weekday - currentWeekday
    if (daysUntilWeekday < 0) {
      daysUntilWeekday += 7
    }

    date = DateTime.add(date, { days: daysUntilWeekday })

    // Add weeks to get to nth occurrence
    date = DateTime.add(date, { days: (nth - 1) * 7 })

    // Verify still in the same month
    const resultParts = DateTime.toParts(date)
    if (resultParts.month !== month) {
      return undefined
    }

    return date
  })

/**
 * Get the last occurrence of a weekday in a month.
 *
 * @param year - The year
 * @param month - The month (1-12)
 * @param weekday - The day of week (0 = Sunday, 6 = Saturday)
 * @returns The date
 */
export const getLastWeekdayOfMonth = (
  year: number,
  month: Month,
  weekday: DayOfWeek,
): Effect.Effect<DateTime.Utc, InvalidYearError | InvalidDateError> =>
  Effect.gen(function* () {
    yield* validateYear(year)

    // Get the last day of the month by going to first of next month and subtracting a day
    const nextMonth = month === 12 ? 1 : month + 1
    const nextYear = month === 12 ? year + 1 : year

    let date = yield* safeDateTime(nextYear, nextMonth, 1)

    // Go back to last day of target month
    date = DateTime.add(date, { days: -1 })

    // Find the last occurrence of the weekday
    const parts = DateTime.toParts(date)
    const currentWeekday = parts.weekDay
    let daysBack = currentWeekday - weekday
    if (daysBack < 0) {
      daysBack += 7
    }

    return DateTime.add(date, { days: -daysBack })
  })

/**
 * Calculate a fixed holiday for a specific year.
 */
export const calculateFixedHoliday = (
  holiday: FixedHoliday,
  year: number,
): Effect.Effect<HolidayInstance, InvalidYearError | InvalidDateError> =>
  Effect.gen(function* () {
    yield* validateYear(year)
    yield* validateDate(year, holiday.month, holiday.day)

    const date = yield* safeDateTime(year, holiday.month, holiday.day)
    return {
      date,
      name: holiday.name,
      rule: holiday,
    }
  })

/**
 * Calculate an nth weekday holiday for a specific year.
 */
export const calculateNthWeekdayHoliday = (
  holiday: NthWeekdayHoliday,
  year: number,
): Effect.Effect<
  HolidayInstance | undefined,
  InvalidYearError | InvalidDateError
> =>
  Effect.gen(function* () {
    const date = yield* getNthWeekdayOfMonth(
      year,
      holiday.month,
      holiday.weekday,
      holiday.nth,
    )
    if (!date) return undefined

    return {
      date,
      name: holiday.name,
      rule: holiday,
    }
  })

/**
 * Calculate a last weekday holiday for a specific year.
 */
export const calculateLastWeekdayHoliday = (
  holiday: LastWeekdayHoliday,
  year: number,
): Effect.Effect<HolidayInstance, InvalidYearError | InvalidDateError> =>
  Effect.gen(function* () {
    const date = yield* getLastWeekdayOfMonth(
      year,
      holiday.month,
      holiday.weekday,
    )
    return {
      date,
      name: holiday.name,
      rule: holiday,
    }
  })

/**
 * Calculate an Easter-relative holiday for a specific year.
 */
export const calculateEasterRelativeHoliday = (
  holiday: EasterRelativeHoliday,
  year: number,
): Effect.Effect<HolidayInstance, InvalidYearError | InvalidDateError> =>
  Effect.gen(function* () {
    const easter = yield* calculateEasterSunday(year)
    return {
      date: DateTime.add(easter, { days: holiday.daysOffset }),
      name: holiday.name,
      rule: holiday,
    }
  })

/**
 * Calculate a holiday for a specific year.
 */
export const calculateHoliday = (
  holiday: Holiday,
  year: number,
): Effect.Effect<
  HolidayInstance | undefined,
  InvalidYearError | InvalidDateError
> => {
  switch (holiday._tag) {
    case "FixedHoliday":
      return calculateFixedHoliday(holiday, year)
    case "NthWeekdayHoliday":
      return calculateNthWeekdayHoliday(holiday, year)
    case "LastWeekdayHoliday":
      return calculateLastWeekdayHoliday(holiday, year)
    case "EasterRelativeHoliday":
      return calculateEasterRelativeHoliday(holiday, year)
  }
}

/**
 * Calculate all holidays for a specific year.
 * Returns an array of holiday instances sorted by date.
 */
export const calculateHolidaysForYear = (
  holidays: readonly Holiday[],
  year: number,
): Effect.Effect<HolidayInstance[], InvalidYearError | InvalidDateError> =>
  Effect.gen(function* () {
    const instances: HolidayInstance[] = []

    for (const holiday of holidays) {
      const instance = yield* calculateHoliday(holiday, year)
      if (instance) {
        instances.push(instance)
      }
    }

    // Sort by date
    return instances.sort((a, b) => {
      const aMillis = DateTime.toEpochMillis(a.date)
      const bMillis = DateTime.toEpochMillis(b.date)
      return aMillis - bMillis
    })
  })

/**
 * Check if a date is a holiday.
 * Compares only the date part (year, month, day).
 * This is a pure function - no Effect needed.
 */
export const isDateHoliday = (
  date: DateTime.Utc,
  holidayInstances: HolidayInstance[],
): HolidayInstance | undefined => {
  const dateParts = DateTime.toParts(date)

  for (const instance of holidayInstances) {
    const instanceParts = DateTime.toParts(instance.date)
    if (
      dateParts.year === instanceParts.year &&
      dateParts.month === instanceParts.month &&
      dateParts.day === instanceParts.day
    ) {
      return instance
    }
  }

  return undefined
}
