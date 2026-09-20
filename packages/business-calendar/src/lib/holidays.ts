import { Schema } from "effect"
import {
  DayOfMonth,
  type DayOfMonth as DayOfMonthType,
  DayOfWeek,
  type DayOfWeek as DayOfWeekType,
  Month,
  type Month as MonthType,
  NthOccurrence,
  type NthOccurrence as NthOccurrenceType,
} from "./types.js"

/**
 * Fixed holiday: occurs on the same date every year.
 * Example: Christmas (December 25), New Year's Day (January 1)
 */
export const FixedHoliday = Schema.TaggedStruct("FixedHoliday", {
  name: Schema.String,
  month: Month,
  day: DayOfMonth,
})
export type FixedHoliday = typeof FixedHoliday.Type

/**
 * Nth weekday holiday: occurs on the nth occurrence of a weekday in a month.
 * Example: MLK Day (3rd Monday of January), Thanksgiving (4th Thursday of November)
 *
 * @property nth - 1st through 5th occurrence (5th means "last or 5th if exists")
 * @property weekday - Day of week (0 = Sunday, 6 = Saturday)
 * @property month - Month (1-12)
 */
export const NthWeekdayHoliday = Schema.TaggedStruct("NthWeekdayHoliday", {
  name: Schema.String,
  month: Month,
  weekday: DayOfWeek,
  nth: NthOccurrence,
})
export type NthWeekdayHoliday = typeof NthWeekdayHoliday.Type

/**
 * Last weekday holiday: occurs on the last occurrence of a weekday in a month.
 * Example: Memorial Day (last Monday of May)
 *
 * @property weekday - Day of week (0 = Sunday, 6 = Saturday)
 * @property month - Month (1-12)
 */
export const LastWeekdayHoliday = Schema.TaggedStruct("LastWeekdayHoliday", {
  name: Schema.String,
  month: Month,
  weekday: DayOfWeek,
})
export type LastWeekdayHoliday = typeof LastWeekdayHoliday.Type

/**
 * Easter-relative holiday: calculated as days offset from Easter Sunday.
 * Example: Good Friday (-2), Easter Monday (+1), Ash Wednesday (-46)
 *
 * @property daysOffset - Positive for after Easter, negative for before
 */
export const EasterRelativeHoliday = Schema.TaggedStruct(
  "EasterRelativeHoliday",
  {
    name: Schema.String,
    daysOffset: Schema.Int,
  },
)
export type EasterRelativeHoliday = typeof EasterRelativeHoliday.Type

/**
 * Union of all holiday types.
 */
export const Holiday = Schema.Union(
  FixedHoliday,
  NthWeekdayHoliday,
  LastWeekdayHoliday,
  EasterRelativeHoliday,
)
export type Holiday = typeof Holiday.Type

/**
 * Computed holiday instance with resolved date.
 * Used for caching and display.
 */
export const HolidayInstance = Schema.Struct({
  date: Schema.DateTimeUtcFromSelf,
  name: Schema.String,
  rule: Schema.optional(Holiday),
})
export type HolidayInstance = typeof HolidayInstance.Type

// Helper functions to create holidays with proper types
// These use Schema.decodeSync for runtime validation of branded types

const decodeMonth = Schema.decodeSync(Month)
const decodeDayOfMonth = Schema.decodeSync(DayOfMonth)
const decodeDayOfWeek = Schema.decodeSync(DayOfWeek)
const decodeNthOccurrence = Schema.decodeSync(NthOccurrence)

/**
 * Create a fixed date holiday.
 * @throws ParseError if month (1-12) or day (1-31) is out of range
 */
export const fixedHoliday = (
  name: string,
  month: number,
  day: number,
): FixedHoliday => ({
  _tag: "FixedHoliday",
  name,
  month: decodeMonth(month),
  day: decodeDayOfMonth(day),
})

/**
 * Create an nth weekday holiday.
 * @throws ParseError if month (1-12), weekday (0-6), or nth (1-5) is out of range
 */
export const nthWeekdayHoliday = (
  name: string,
  month: number,
  weekday: number,
  nth: number,
): NthWeekdayHoliday => ({
  _tag: "NthWeekdayHoliday",
  name,
  month: decodeMonth(month),
  weekday: decodeDayOfWeek(weekday),
  nth: decodeNthOccurrence(nth),
})

/**
 * Create a last weekday of month holiday.
 * @throws ParseError if month (1-12) or weekday (0-6) is out of range
 */
export const lastWeekdayHoliday = (
  name: string,
  month: number,
  weekday: number,
): LastWeekdayHoliday => ({
  _tag: "LastWeekdayHoliday",
  name,
  month: decodeMonth(month),
  weekday: decodeDayOfWeek(weekday),
})

/**
 * Create an Easter-relative holiday.
 */
export const easterRelativeHoliday = (
  name: string,
  daysOffset: number,
): EasterRelativeHoliday => ({
  _tag: "EasterRelativeHoliday",
  name,
  daysOffset,
})

// Type-safe variants that accept already-validated branded types

/**
 * Create a fixed date holiday with pre-validated branded types.
 */
export const fixedHolidayTyped = (
  name: string,
  month: MonthType,
  day: DayOfMonthType,
): FixedHoliday => ({
  _tag: "FixedHoliday",
  name,
  month,
  day,
})

/**
 * Create an nth weekday holiday with pre-validated branded types.
 */
export const nthWeekdayHolidayTyped = (
  name: string,
  month: MonthType,
  weekday: DayOfWeekType,
  nth: NthOccurrenceType,
): NthWeekdayHoliday => ({
  _tag: "NthWeekdayHoliday",
  name,
  month,
  weekday,
  nth,
})

/**
 * Create a last weekday of month holiday with pre-validated branded types.
 */
export const lastWeekdayHolidayTyped = (
  name: string,
  month: MonthType,
  weekday: DayOfWeekType,
): LastWeekdayHoliday => ({
  _tag: "LastWeekdayHoliday",
  name,
  month,
  weekday,
})

// Common holidays

/**
 * Common US holidays.
 */
export const US_HOLIDAYS: Holiday[] = [
  fixedHoliday("New Year's Day", 1, 1),
  nthWeekdayHoliday("Martin Luther King Jr. Day", 1, 1, 3), // 3rd Monday of January
  nthWeekdayHoliday("Presidents' Day", 2, 1, 3), // 3rd Monday of February
  lastWeekdayHoliday("Memorial Day", 5, 1), // Last Monday of May
  fixedHoliday("Independence Day", 7, 4),
  nthWeekdayHoliday("Labor Day", 9, 1, 1), // 1st Monday of September
  nthWeekdayHoliday("Columbus Day", 10, 1, 2), // 2nd Monday of October
  fixedHoliday("Veterans Day", 11, 11),
  nthWeekdayHoliday("Thanksgiving", 11, 4, 4), // 4th Thursday of November
  fixedHoliday("Christmas Day", 12, 25),
]

/**
 * Common Dutch holidays.
 */
export const NL_HOLIDAYS: Holiday[] = [
  fixedHoliday("Nieuwjaarsdag", 1, 1), // New Year's Day
  fixedHoliday("Koningsdag", 4, 27), // King's Day
  fixedHoliday("Bevrijdingsdag", 5, 5), // Liberation Day
  fixedHoliday("Eerste Kerstdag", 12, 25), // Christmas Day
  fixedHoliday("Tweede Kerstdag", 12, 26), // Boxing Day
  easterRelativeHoliday("Goede Vrijdag", -2), // Good Friday
  easterRelativeHoliday("Eerste Paasdag", 0), // Easter Sunday
  easterRelativeHoliday("Tweede Paasdag", 1), // Easter Monday
  easterRelativeHoliday("Hemelvaartsdag", 39), // Ascension Day
  easterRelativeHoliday("Eerste Pinksterdag", 49), // Whit Sunday
  easterRelativeHoliday("Tweede Pinksterdag", 50), // Whit Monday
]

/**
 * Common NZ holidays.
 */
export const NZ_HOLIDAYS: Holiday[] = [
  fixedHoliday("New Year's Day", 1, 1),
  fixedHoliday("Day after New Year's Day", 1, 2),
  fixedHoliday("Waitangi Day", 2, 6),
  easterRelativeHoliday("Good Friday", -2),
  easterRelativeHoliday("Easter Monday", 1),
  fixedHoliday("Anzac Day", 4, 25),
  nthWeekdayHoliday("Queen's Birthday", 6, 1, 1), // 1st Monday of June
  nthWeekdayHoliday("Labour Day", 10, 1, 4), // 4th Monday of October
  fixedHoliday("Christmas Day", 12, 25),
  fixedHoliday("Boxing Day", 12, 26),
]
