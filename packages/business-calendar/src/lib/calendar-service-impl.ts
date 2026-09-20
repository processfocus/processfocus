import {
  Cause,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  SynchronizedRef,
} from "effect"
import type {
  BusinessCalendarConfig,
  DateException,
} from "./calendar-config.js"
import type { CalendarPeriod } from "./calendar-period.js"
import {
  BusinessCalendarConfigService,
  BusinessCalendarError,
  BusinessCalendarService,
  type BusinessCalendarServiceShape,
} from "./calendar-service.js"
import {
  calculateHolidaysForYear,
  isDateHoliday,
} from "./holiday-calculator.js"
import type { HolidayInstance } from "./holidays.js"
import type { DayOfWeek, DaySchedule, TimeOfDay, TimeRange } from "./types.js"
import { isOvernightRange, timeOfDayToMinutes } from "./types.js"

/**
 * In-flight waiters share a deferred that fails with "abandoned" when the
 * owner is interrupted/cancelled so joiners can re-enter the cache without
 * being cancelled themselves.
 */
type HolidayInFlightDeferred = Deferred.Deferred<HolidayInstance[], "abandoned">

/** Success-only holiday cache entry (in-flight work is not permanently stored). */
type HolidayCacheEntry =
  | {
      readonly _tag: "Done"
      readonly holidays: HolidayInstance[]
    }
  | {
      readonly _tag: "InFlight"
      readonly deferred: HolidayInFlightDeferred
    }

/** Maximum number of business days to add/subtract (prevents infinite loops) */
const MAX_BUSINESS_DAYS = 10000

/** Maximum number of business hours to add (prevents infinite loops) */
const MAX_BUSINESS_HOURS = 100000

/** Maximum number of days to search for next business day */
const MAX_SEARCH_DAYS = 365

/**
 * Create the BusinessCalendarService implementation from a config.
 *
 * Prefer this at call sites that already hold a resolved config and need a
 * service value (pass it into helpers) rather than embedding `Effect.provide`
 * inside reusable package logic.
 */
export const makeBusinessCalendarService = (
  config: BusinessCalendarConfig,
): Effect.Effect<BusinessCalendarServiceShape, never, never> =>
  Effect.gen(function* () {
    // Create timezone zone for local time conversions
    // Defaults to UTC if no timezone specified
    const timezone = config.timezone
      ? DateTime.zoneUnsafeMakeNamed(config.timezone)
      : DateTime.zoneUnsafeMakeNamed("UTC")

    /**
     * Get date/time parts in the calendar's local timezone.
     * This is critical for correctly interpreting schedule times.
     */
    const getLocalParts = (utcDateTime: DateTime.Utc) => {
      const zoned = DateTime.setZone(utcDateTime, timezone)
      return DateTime.toParts(zoned)
    }

    /**
     * Create a UTC DateTime from local date/time parts.
     * Used when we need to return a specific time in the calendar's timezone as UTC.
     */
    const makeUtcFromLocalParts = (
      year: number,
      month: number,
      day: number,
      hours: number,
      minutes: number,
    ): DateTime.Utc => {
      // Create a zoned datetime in the local timezone, treating input as local time
      const zoned = DateTime.unsafeMakeZoned(
        { year, month, day, hours, minutes, seconds: 0, millis: 0 },
        { timeZone: timezone, adjustForTimeZone: true },
      )
      // Convert to UTC
      return DateTime.toUtc(zoned)
    }

    /**
     * Get holidays for a year with a success-only cache that still shares
     * in-flight computation across concurrent callers.
     *
     * Unlike Effect.cachedFunction, interrupted owners drop the in-flight entry
     * and signal abandonment to waiters (who re-enter the cache) instead of
     * permanently memoizing Failure(interrupt) or cancelling joiners.
     * Successful results (including intentional [] fallbacks after logged
     * failures) are committed to the cache.
     */
    const holidayCacheRef = yield* SynchronizedRef.make(
      new Map<number, HolidayCacheEntry>(),
    )

    const computeHolidaysForYear = (
      year: number,
    ): Effect.Effect<HolidayInstance[], never, never> =>
      calculateHolidaysForYear(config.holidays, year).pipe(
        Effect.catchAllCause(
          (cause): Effect.Effect<HolidayInstance[], never, never> => {
            // Interrupts and defects are re-raised so they are never converted
            // into a cacheable success []. Typed Fail causes log and fall back
            // to [] (calendar ops keep working with degraded holiday data).
            if (Cause.isInterrupted(cause) || Cause.isDie(cause)) {
              return Effect.failCause(cause as Cause.Cause<never>)
            }
            return Effect.logWarning(
              "Failed to compute holidays for year",
              cause,
            ).pipe(
              Effect.annotateLogs({ year }),
              Effect.as([] as HolidayInstance[]),
            )
          },
        ),
      )

    const getHolidaysForYearCached = (
      year: number,
    ): Effect.Effect<HolidayInstance[], never, never> =>
      // Cache bookkeeping (register InFlight, commit Done, abandon on interrupt)
      // stays uninterruptible so a cancelled owner never leaves a dangling
      // deferred. Compute and join await are interruptible via restore().
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          type Acquire =
            | { readonly _tag: "hit"; readonly holidays: HolidayInstance[] }
            | {
                readonly _tag: "join"
                readonly deferred: HolidayInFlightDeferred
              }
            | {
                readonly _tag: "owner"
                readonly deferred: HolidayInFlightDeferred
              }

          const acquired = yield* SynchronizedRef.modifyEffect(
            holidayCacheRef,
            (
              map,
            ): Effect.Effect<
              readonly [Acquire, Map<number, HolidayCacheEntry>]
            > => {
              const existing = map.get(year)
              if (existing !== undefined) {
                if (existing._tag === "Done") {
                  return Effect.succeed([
                    { _tag: "hit", holidays: existing.holidays },
                    map,
                  ])
                }
                return Effect.succeed([
                  { _tag: "join", deferred: existing.deferred },
                  map,
                ])
              }

              return Deferred.make<HolidayInstance[], "abandoned">().pipe(
                Effect.map((deferred) => {
                  const next = new Map(map)
                  next.set(year, { _tag: "InFlight", deferred })
                  return [{ _tag: "owner", deferred }, next] as const
                }),
              )
            },
          )

          switch (acquired._tag) {
            case "hit":
              return acquired.holidays
            case "join":
              // Owner abandonment is a typed fail; retry re-enters the cache.
              // Joiner interrupts still propagate (catchAll does not swallow them).
              return yield* restore(
                Deferred.await(acquired.deferred).pipe(
                  Effect.catchAll(() => getHolidaysForYearCached(year)),
                ),
              )
            case "owner": {
              const exit = yield* Effect.exit(
                restore(
                  Effect.gen(function* () {
                    // Cooperative yield so tests / cancellation can land
                    // after InFlight registration.
                    yield* Effect.yieldNow()
                    return yield* computeHolidaysForYear(year)
                  }),
                ),
              )

              if (Exit.isSuccess(exit)) {
                yield* Deferred.succeed(acquired.deferred, exit.value)
                yield* SynchronizedRef.update(holidayCacheRef, (map) => {
                  const current = map.get(year)
                  // Only commit Done if we still own this year's InFlight entry
                  // (mirrors the abandon-path deferred identity guard).
                  if (
                    current?._tag === "InFlight" &&
                    current.deferred === acquired.deferred
                  ) {
                    const next = new Map(map)
                    next.set(year, {
                      _tag: "Done",
                      holidays: exit.value,
                    })
                    return next
                  }
                  return map
                })
                return exit.value
              }

              // Do not Deferred.done with the owner's interrupt: that would
              // cancel concurrent joiners. Signal abandonment and re-raise
              // only for the owner.
              yield* SynchronizedRef.update(holidayCacheRef, (map) => {
                const current = map.get(year)
                if (
                  current?._tag === "InFlight" &&
                  current.deferred === acquired.deferred
                ) {
                  const next = new Map(map)
                  next.delete(year)
                  return next
                }
                return map
              })
              yield* Deferred.fail(acquired.deferred, "abandoned")
              return yield* Effect.failCause(exit.cause as Cause.Cause<never>)
            }
          }
        }),
      )

    /**
     * Get date exception for a specific date.
     * Compares dates in the calendar's local timezone.
     */
    const getDateException = (
      date: DateTime.Utc,
    ): DateException | undefined => {
      const dateParts = getLocalParts(date)
      for (const exception of config.exceptions) {
        // Exception dates are also compared in local timezone
        const exParts = getLocalParts(exception.date)
        if (
          dateParts.year === exParts.year &&
          dateParts.month === exParts.month &&
          dateParts.day === exParts.day
        ) {
          return exception
        }
      }
      return undefined
    }

    /**
     * Get periods active on a date.
     */
    const getActivePeriodsForDate = (date: DateTime.Utc): CalendarPeriod[] => {
      const dateMillis = DateTime.toEpochMillis(date)
      return [...config.periods].filter((period) => {
        const startMillis = DateTime.toEpochMillis(period.startDate)
        const endMillis = DateTime.toEpochMillis(period.endDate)
        return (
          period.isActive &&
          dateMillis >= startMillis &&
          dateMillis <= endMillis
        )
      })
    }

    /**
     * Check if date is within any active period of required type.
     */
    const isWithinRequiredPeriod = (date: DateTime.Utc): boolean => {
      if (!config.requireActivePeriod) {
        return true
      }

      const dateMillis = DateTime.toEpochMillis(date)
      for (const period of config.periods) {
        if (period.type !== config.requireActivePeriod || !period.isActive) {
          continue
        }
        const startMillis = DateTime.toEpochMillis(period.startDate)
        const endMillis = DateTime.toEpochMillis(period.endDate)
        if (dateMillis >= startMillis && dateMillis <= endMillis) {
          return true
        }
      }
      return false
    }

    /**
     * Get the effective weekly schedule for a date.
     * Priority: period override > default schedule
     */
    const getEffectiveWeeklySchedule = (
      date: DateTime.Utc,
    ): readonly DaySchedule[] => {
      // Check for period-specific schedule
      const activePeriods = getActivePeriodsForDate(date)
      for (const period of activePeriods) {
        if (period.weeklySchedule) {
          return period.weeklySchedule
        }
      }
      return config.weeklySchedule
    }

    /**
     * Get the schedule for a specific day of week.
     */
    const getScheduleForDayOfWeek = (
      schedule: readonly DaySchedule[],
      dayOfWeek: DayOfWeek,
    ): DaySchedule | undefined => schedule.find((s) => s.day === dayOfWeek)

    /**
     * Check if a time falls within a time range.
     * Handles overnight ranges correctly.
     */
    const isTimeInRange = (time: TimeOfDay, range: TimeRange): boolean => {
      const timeMinutes = timeOfDayToMinutes(time)
      const openMinutes = timeOfDayToMinutes(range.open)
      const closeMinutes = timeOfDayToMinutes(range.close)

      if (isOvernightRange(range)) {
        // Overnight range: 22:00-06:00 means time >= 22:00 OR time < 06:00
        return timeMinutes >= openMinutes || timeMinutes < closeMinutes
      }
      // Normal range: 09:00-17:00
      return timeMinutes >= openMinutes && timeMinutes < closeMinutes
    }

    /**
     * Calculate business minutes remaining in a time range from a given time.
     */
    const minutesRemainingInRange = (
      time: TimeOfDay,
      range: TimeRange,
    ): number => {
      const timeMinutes = timeOfDayToMinutes(time)
      const closeMinutes = timeOfDayToMinutes(range.close)

      if (isOvernightRange(range)) {
        // Overnight range
        if (timeMinutes >= timeOfDayToMinutes(range.open)) {
          // Before midnight
          return 24 * 60 - timeMinutes + closeMinutes
        }
        // After midnight
        return closeMinutes - timeMinutes
      }

      // Normal range
      return closeMinutes - timeMinutes
    }

    const MINUTES_PER_DAY = 24 * 60

    /**
     * Intersection length of [aStart, aEnd) and [bStart, bEnd) in minutes.
     */
    const intervalIntersectionMinutes = (
      aStart: number,
      aEnd: number,
      bStart: number,
      bEnd: number,
    ): number => Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart))

    /**
     * Business minutes of a single range that fall within [windowStart, windowEnd)
     * on one calendar day (minutes since local midnight). Overnight ranges contribute
     * both the evening segment and the early-morning segment of that same day.
     */
    const rangeMinutesInWindow = (
      range: TimeRange,
      windowStart: number,
      windowEnd: number,
    ): number => {
      if (windowEnd <= windowStart) {
        return 0
      }

      const openMinutes = timeOfDayToMinutes(range.open)
      const closeMinutes = timeOfDayToMinutes(range.close)

      if (isOvernightRange(range)) {
        return (
          intervalIntersectionMinutes(
            openMinutes,
            MINUTES_PER_DAY,
            windowStart,
            windowEnd,
          ) +
          intervalIntersectionMinutes(0, closeMinutes, windowStart, windowEnd)
        )
      }

      return intervalIntersectionMinutes(
        openMinutes,
        closeMinutes,
        windowStart,
        windowEnd,
      )
    }

    /**
     * Resolve the effective time ranges for a date (exceptions before weekly schedule).
     * Returns empty when the day has no slots. Caller must still check isBusinessDay
     * for holidays / non-working days / required periods.
     */
    const getRangesForDate = (date: DateTime.Utc): readonly TimeRange[] => {
      const exception = getDateException(date)
      if (exception) {
        if (exception.slots === "closed") {
          return []
        }
        return exception.slots
      }

      const parts = getLocalParts(date)
      const schedule = getEffectiveWeeklySchedule(date)
      const daySchedule = getScheduleForDayOfWeek(
        schedule,
        parts.weekDay as DayOfWeek,
      )
      return daySchedule?.ranges ?? []
    }

    const isSameLocalDate = (a: DateTime.Utc, b: DateTime.Utc): boolean => {
      const aParts = getLocalParts(a)
      const bParts = getLocalParts(b)
      return (
        aParts.year === bParts.year &&
        aParts.month === bParts.month &&
        aParts.day === bParts.day
      )
    }

    /**
     * Service implementation
     */
    const service: BusinessCalendarServiceShape = {
      isBusinessDay: (date) =>
        Effect.gen(function* () {
          // Use local timezone to determine the weekday
          const parts = getLocalParts(date)

          // Check if exception marks it as closed
          const exception = getDateException(date)
          if (exception?.slots === "closed") {
            return false
          }

          // Check non-working days (weekends)
          if (config.nonWorkingDays.includes(parts.weekDay as DayOfWeek)) {
            return false
          }

          // Check holidays against the calendar's local civil date. Holiday
          // instances are stored at UTC midnight of that civil date; comparing
          // the probe's UTC y/m/d would misclassify local midnight in UTC+ zones
          // (e.g. Europe/Berlin 00:00 on Christmas is still 23:00 UTC previous day).
          const holidays = yield* getHolidaysForYearCached(parts.year)
          const civilDateForHoliday = DateTime.unsafeMake({
            year: parts.year,
            month: parts.month,
            day: parts.day,
          })
          if (isDateHoliday(civilDateForHoliday, holidays)) {
            return false
          }

          // Check required period
          if (!isWithinRequiredPeriod(date)) {
            return false
          }

          // Check if there's any schedule for this day
          const schedule = getEffectiveWeeklySchedule(date)
          const daySchedule = getScheduleForDayOfWeek(
            schedule,
            parts.weekDay as DayOfWeek,
          )

          // If there's an exception with custom slots, it's a business day
          if (exception && typeof exception.slots !== "string") {
            return true
          }

          // If no schedule defined for this day, it's not a business day
          if (!daySchedule || daySchedule.ranges.length === 0) {
            return false
          }

          return true
        }),

      isBusinessHours: (datetime) =>
        Effect.gen(function* () {
          const isBusinessDayResult = yield* service.isBusinessDay(datetime)
          if (!isBusinessDayResult) {
            return false
          }

          // Use local timezone to determine the current time of day
          const parts = getLocalParts(datetime)
          const currentTime: TimeOfDay = {
            hour: parts.hours,
            minute: parts.minutes,
          }

          // Check exception first
          const exception = getDateException(datetime)
          if (exception && typeof exception.slots !== "string") {
            for (const range of exception.slots) {
              if (isTimeInRange(currentTime, range)) {
                return true
              }
            }
            return false
          }

          // Get effective schedule
          const schedule = getEffectiveWeeklySchedule(datetime)
          const daySchedule = getScheduleForDayOfWeek(
            schedule,
            parts.weekDay as DayOfWeek,
          )

          if (!daySchedule) {
            return false
          }

          for (const range of daySchedule.ranges) {
            if (isTimeInRange(currentTime, range)) {
              return true
            }
          }

          return false
        }),

      addBusinessDays: (date, days) =>
        Effect.gen(function* () {
          if (days === 0 || !Number.isFinite(days)) {
            return date
          }

          // Clamp to reasonable bounds to prevent infinite loops
          const clampedDays = Math.max(
            -MAX_BUSINESS_DAYS,
            Math.min(MAX_BUSINESS_DAYS, Math.round(days)),
          )

          let current = date
          let remaining = Math.abs(clampedDays)
          const direction = clampedDays > 0 ? 1 : -1
          let iterations = 0

          while (remaining > 0 && iterations < MAX_BUSINESS_DAYS * 2) {
            iterations++
            current = DateTime.add(current, { days: direction })
            const isBusinessDayResult = yield* service.isBusinessDay(current)
            if (isBusinessDayResult) {
              remaining--
            }
          }

          return current
        }),

      addBusinessHours: (datetime, hours) =>
        Effect.gen(function* () {
          if (hours <= 0 || !Number.isFinite(hours)) {
            return datetime
          }

          // Clamp to reasonable bounds
          const clampedHours = Math.min(MAX_BUSINESS_HOURS, hours)
          let current = datetime
          let remainingMinutes = Math.round(clampedHours * 60)
          let iterations = 0
          const maxIterations = remainingMinutes + MAX_SEARCH_DAYS * 24 * 60 // reasonable upper bound

          while (remainingMinutes > 0 && iterations < maxIterations) {
            iterations++
            const isInBusinessHours = yield* service.isBusinessHours(current)

            if (!isInBusinessHours) {
              // Move to start of next business day
              const nextDay = yield* service.nextBusinessDay(current)
              const startOpt = yield* service.businessDayStart(nextDay)
              if (Option.isNone(startOpt)) {
                // Should not happen if nextBusinessDay works correctly
                current = DateTime.add(nextDay, { days: 1 })
                continue
              }
              current = startOpt.value
              continue
            }

            // We're in business hours - calculate time remaining in current range
            // Use local timezone to determine current time of day
            const parts = getLocalParts(current)
            const currentTime: TimeOfDay = {
              hour: parts.hours,
              minute: parts.minutes,
            }

            // Get current range
            const exception = getDateException(current)
            let ranges: readonly TimeRange[]
            if (exception && typeof exception.slots !== "string") {
              ranges = exception.slots
            } else {
              const schedule = getEffectiveWeeklySchedule(current)
              const daySchedule = getScheduleForDayOfWeek(
                schedule,
                parts.weekDay as DayOfWeek,
              )
              ranges = daySchedule?.ranges ?? []
            }

            // Find current range and calculate remaining time
            let minutesInCurrentRange = 0
            for (const range of ranges) {
              if (isTimeInRange(currentTime, range)) {
                minutesInCurrentRange = minutesRemainingInRange(
                  currentTime,
                  range,
                )
                break
              }
            }

            if (minutesInCurrentRange >= remainingMinutes) {
              // We finish within this range
              return DateTime.add(current, { minutes: remainingMinutes })
            }

            // Move to end of current range and continue
            remainingMinutes -= minutesInCurrentRange
            current = DateTime.add(current, { minutes: minutesInCurrentRange })

            // Check if there are more ranges today
            const newParts = getLocalParts(current)
            const newTime: TimeOfDay = {
              hour: newParts.hours,
              minute: newParts.minutes,
            }

            let foundNextRange = false
            for (const range of ranges) {
              const rangeOpenMinutes = timeOfDayToMinutes(range.open)
              const currentMinutes = timeOfDayToMinutes(newTime)
              if (
                rangeOpenMinutes > currentMinutes &&
                !isOvernightRange(range)
              ) {
                // There's a later range today
                const minutesToNextRange = rangeOpenMinutes - currentMinutes
                current = DateTime.add(current, { minutes: minutesToNextRange })
                foundNextRange = true
                break
              }
            }

            if (!foundNextRange) {
              // Move to start of next business day
              const nextDay = yield* service.nextBusinessDay(current)
              const startOpt = yield* service.businessDayStart(nextDay)
              if (Option.isNone(startOpt)) {
                current = DateTime.add(nextDay, { days: 1 })
                continue
              }
              current = startOpt.value
            }
          }

          return current
        }),

      nextBusinessDay: (date) =>
        Effect.gen(function* () {
          let current = DateTime.add(date, { days: 1 })
          // Set to start of day in local timezone
          const parts = getLocalParts(current)
          current = makeUtcFromLocalParts(
            parts.year,
            parts.month,
            parts.day,
            0,
            0,
          )

          // Safety limit to prevent infinite loop if no business days exist
          let iterations = 0
          while (iterations < MAX_SEARCH_DAYS) {
            iterations++
            const isBusinessDayResult = yield* service.isBusinessDay(current)
            if (isBusinessDayResult) {
              return current
            }
            current = DateTime.add(current, { days: 1 })
          }

          // If no business day found within limit, this indicates a calendar configuration issue
          return yield* new BusinessCalendarError({
            message: `No business day found within ${MAX_SEARCH_DAYS} days of ${DateTime.toUtc(date)}, possible misconfigured calendar`,
          })
        }),

      previousBusinessDay: (date) =>
        Effect.gen(function* () {
          // Normalize input to start of day first to avoid DST edge cases
          const parts = getLocalParts(date)
          let current = makeUtcFromLocalParts(
            parts.year,
            parts.month,
            parts.day,
            0,
            0,
          )
          // Then go back one day
          current = DateTime.add(current, { days: -1 })

          // Safety limit to prevent infinite loop if no business days exist
          let iterations = 0
          while (iterations < MAX_SEARCH_DAYS) {
            iterations++
            const isBusinessDayResult = yield* service.isBusinessDay(current)
            if (isBusinessDayResult) {
              return current
            }
            current = DateTime.add(current, { days: -1 })
          }

          // If no business day found within limit, this indicates a calendar configuration issue
          return yield* new BusinessCalendarError({
            message: `No business day found within ${MAX_SEARCH_DAYS} days of ${DateTime.toUtc(date)}, possible misconfigured calendar`,
          })
        }),

      businessDayStart: (date) =>
        Effect.gen(function* () {
          const isBusinessDayResult = yield* service.isBusinessDay(date)
          if (!isBusinessDayResult) {
            return Option.none()
          }

          // Use local timezone to determine the date
          const parts = getLocalParts(date)

          // Check exception first
          const exception = getDateException(date)
          if (exception && typeof exception.slots !== "string") {
            const slots = exception.slots
            const firstSlot = slots[0]
            if (!firstSlot) return Option.none()
            // Find earliest opening time
            let earliest = firstSlot.open
            for (const slot of slots) {
              if (
                timeOfDayToMinutes(slot.open) < timeOfDayToMinutes(earliest)
              ) {
                earliest = slot.open
              }
            }
            // Create time in local timezone and convert to UTC
            return Option.some(
              makeUtcFromLocalParts(
                parts.year,
                parts.month,
                parts.day,
                earliest.hour,
                earliest.minute,
              ),
            )
          }

          const schedule = getEffectiveWeeklySchedule(date)
          const daySchedule = getScheduleForDayOfWeek(
            schedule,
            parts.weekDay as DayOfWeek,
          )

          const firstRange = daySchedule?.ranges[0]
          if (!daySchedule || !firstRange) {
            return Option.none()
          }

          // Find earliest opening time
          let earliest = firstRange.open
          for (const range of daySchedule.ranges) {
            if (timeOfDayToMinutes(range.open) < timeOfDayToMinutes(earliest)) {
              earliest = range.open
            }
          }

          // Create time in local timezone and convert to UTC
          return Option.some(
            makeUtcFromLocalParts(
              parts.year,
              parts.month,
              parts.day,
              earliest.hour,
              earliest.minute,
            ),
          )
        }),

      businessDayEnd: (date) =>
        Effect.gen(function* () {
          const isBusinessDayResult = yield* service.isBusinessDay(date)
          if (!isBusinessDayResult) {
            return Option.none()
          }

          // Use local timezone to determine the date
          const parts = getLocalParts(date)

          // Check exception first
          const exception = getDateException(date)
          if (exception && typeof exception.slots !== "string") {
            const slots = exception.slots
            const firstSlot = slots[0]
            if (!firstSlot) return Option.none()
            // Find latest closing time (considering overnight ranges)
            let latest = firstSlot.close
            for (const slot of slots) {
              // For overnight ranges, close time is next day
              if (isOvernightRange(slot)) {
                // Overnight end is always later than same-day end
                latest = slot.close
              } else if (
                timeOfDayToMinutes(slot.close) > timeOfDayToMinutes(latest) &&
                !isOvernightRange({ open: firstSlot.open, close: latest })
              ) {
                latest = slot.close
              }
            }
            // Create time in local timezone and convert to UTC
            return Option.some(
              makeUtcFromLocalParts(
                parts.year,
                parts.month,
                parts.day,
                latest.hour,
                latest.minute,
              ),
            )
          }

          const schedule = getEffectiveWeeklySchedule(date)
          const daySchedule = getScheduleForDayOfWeek(
            schedule,
            parts.weekDay as DayOfWeek,
          )

          const firstRangeEnd = daySchedule?.ranges[0]
          if (!daySchedule || !firstRangeEnd) {
            return Option.none()
          }

          // Find latest closing time
          let latest = firstRangeEnd.close
          for (const range of daySchedule.ranges) {
            if (isOvernightRange(range)) {
              latest = range.close
            } else if (
              timeOfDayToMinutes(range.close) > timeOfDayToMinutes(latest) &&
              !isOvernightRange({
                open: firstRangeEnd.open,
                close: latest,
              })
            ) {
              latest = range.close
            }
          }

          // Create time in local timezone and convert to UTC
          return Option.some(
            makeUtcFromLocalParts(
              parts.year,
              parts.month,
              parts.day,
              latest.hour,
              latest.minute,
            ),
          )
        }),

      businessHoursRemaining: (datetime) =>
        Effect.gen(function* () {
          const isInBusinessHours = yield* service.isBusinessHours(datetime)
          if (!isInBusinessHours) {
            return Duration.zero
          }

          // Use local timezone to determine current time of day
          const parts = getLocalParts(datetime)
          const currentTime: TimeOfDay = {
            hour: parts.hours,
            minute: parts.minutes,
          }

          // Get current ranges
          const exception = getDateException(datetime)
          let ranges: readonly TimeRange[]
          if (exception && typeof exception.slots !== "string") {
            ranges = exception.slots
          } else {
            const schedule = getEffectiveWeeklySchedule(datetime)
            const daySchedule = getScheduleForDayOfWeek(
              schedule,
              parts.weekDay as DayOfWeek,
            )
            ranges = daySchedule?.ranges ?? []
          }

          let totalMinutes = 0

          // Find current range and add remaining time
          let inCurrentRange = false
          for (const range of ranges) {
            if (isTimeInRange(currentTime, range)) {
              totalMinutes += minutesRemainingInRange(currentTime, range)
              inCurrentRange = true
            } else if (
              inCurrentRange &&
              timeOfDayToMinutes(range.open) > timeOfDayToMinutes(currentTime)
            ) {
              // Add future ranges
              totalMinutes +=
                timeOfDayToMinutes(range.close) - timeOfDayToMinutes(range.open)
            }
          }

          return Duration.minutes(totalMinutes)
        }),

      businessDaysBetween: (start, end) =>
        Effect.gen(function* () {
          const startMillis = DateTime.toEpochMillis(start)
          const endMillis = DateTime.toEpochMillis(end)

          if (startMillis >= endMillis) {
            return 0
          }

          let count = 0
          let current = start

          while (DateTime.toEpochMillis(current) < endMillis) {
            const isBusinessDayResult = yield* service.isBusinessDay(current)
            if (isBusinessDayResult) {
              count++
            }
            current = DateTime.add(current, { days: 1 })
          }

          return count
        }),

      businessHoursBetween: (start, end) =>
        Effect.gen(function* () {
          const startMillis = DateTime.toEpochMillis(start)
          const endMillis = DateTime.toEpochMillis(end)

          if (startMillis >= endMillis) {
            return Duration.zero
          }

          /**
           * Business minutes on a single local calendar day within
           * [windowStart, windowEnd) (minutes since local midnight).
           */
          const businessMinutesOnDayInWindow = (
            date: DateTime.Utc,
            windowStart: number,
            windowEnd: number,
          ): Effect.Effect<number, never, never> =>
            Effect.gen(function* () {
              const isBusinessDayResult = yield* service.isBusinessDay(date)
              if (!isBusinessDayResult) {
                return 0
              }

              const ranges = getRangesForDate(date)
              let total = 0
              for (const range of ranges) {
                total += rangeMinutesInWindow(range, windowStart, windowEnd)
              }
              return total
            })

          // Day-range arithmetic: full middle days in O(1) per day; only the
          // start/end boundary days use a partial window. O(minutes) → O(days).
          const startParts = getLocalParts(start)
          const endParts = getLocalParts(end)
          const startMinuteOfDay = startParts.hours * 60 + startParts.minutes
          const endMinuteOfDay = endParts.hours * 60 + endParts.minutes

          if (isSameLocalDate(start, end)) {
            const minutes = yield* businessMinutesOnDayInWindow(
              start,
              startMinuteOfDay,
              endMinuteOfDay,
            )
            return Duration.minutes(minutes)
          }

          let totalMinutes = 0

          // First (partial) day: from start time through end of local day
          totalMinutes += yield* businessMinutesOnDayInWindow(
            start,
            startMinuteOfDay,
            MINUTES_PER_DAY,
          )

          // Middle full days. Probe each day at local noon so the civil date
          // is unambiguous across UTC offsets (and DST transitions).
          let dayCursor = makeUtcFromLocalParts(
            startParts.year,
            startParts.month,
            startParts.day,
            12,
            0,
          )
          // Advance from start day to the first middle day
          dayCursor = DateTime.add(dayCursor, { days: 1 })
          const endLocalNoon = makeUtcFromLocalParts(
            endParts.year,
            endParts.month,
            endParts.day,
            12,
            0,
          )

          while (
            DateTime.toEpochMillis(dayCursor) <
            DateTime.toEpochMillis(endLocalNoon)
          ) {
            totalMinutes += yield* businessMinutesOnDayInWindow(
              dayCursor,
              0,
              MINUTES_PER_DAY,
            )
            // Step via local noon + 1 calendar day to stay DST-aligned
            const cursorLocal = getLocalParts(dayCursor)
            dayCursor = DateTime.add(
              makeUtcFromLocalParts(
                cursorLocal.year,
                cursorLocal.month,
                cursorLocal.day,
                12,
                0,
              ),
              { days: 1 },
            )
          }

          // Last (partial) day: from local midnight through end time
          totalMinutes += yield* businessMinutesOnDayInWindow(
            end,
            0,
            endMinuteOfDay,
          )

          return Duration.minutes(totalMinutes)
        }),

      isHoliday: (date) =>
        Effect.gen(function* () {
          // Match holidays by local civil date (see isBusinessDay).
          const parts = getLocalParts(date)
          const holidays = yield* getHolidaysForYearCached(parts.year)
          const civilDateForHoliday = DateTime.unsafeMake({
            year: parts.year,
            month: parts.month,
            day: parts.day,
          })
          return isDateHoliday(civilDateForHoliday, holidays) !== undefined
        }),

      getHolidaysForYear: (year) => getHolidaysForYearCached(year),

      getActivePeriods: (date) => Effect.succeed(getActivePeriodsForDate(date)),

      getActivePeriodsByType: (date, type) =>
        Effect.succeed(
          getActivePeriodsForDate(date).filter((p) => p.type === type),
        ),

      isWithinPeriodType: (date, type) =>
        Effect.succeed(
          getActivePeriodsForDate(date).some((p) => p.type === type),
        ),

      getPeriodsForDateRange: (start, end, type) =>
        Effect.succeed(
          [...config.periods].filter((period) => {
            if (type && period.type !== type) {
              return false
            }
            const periodStart = DateTime.toEpochMillis(period.startDate)
            const periodEnd = DateTime.toEpochMillis(period.endDate)
            const rangeStart = DateTime.toEpochMillis(start)
            const rangeEnd = DateTime.toEpochMillis(end)

            // Check for overlap
            return periodStart <= rangeEnd && periodEnd >= rangeStart
          }),
        ),

      getEffectiveSchedule: (date) =>
        Effect.sync(() => {
          // Check exception first
          const exception = getDateException(date)
          if (exception) {
            if (exception.slots === "closed") {
              return []
            }
            // Use local timezone to determine the day of week
            const parts = getLocalParts(date)
            return [
              {
                day: parts.weekDay as DayOfWeek,
                ranges: [...exception.slots],
              },
            ]
          }

          return [...getEffectiveWeeklySchedule(date)]
        }),
    }

    return service
  })

/**
 * Layer that provides BusinessCalendarService from BusinessCalendarConfigService.
 */
export const BusinessCalendarServiceLive = Layer.effect(
  BusinessCalendarService,
  Effect.flatMap(BusinessCalendarConfigService, makeBusinessCalendarService),
)

/**
 * Create a Layer with a specific config.
 */
export const makeBusinessCalendarServiceLayer = (
  config: BusinessCalendarConfig,
): Layer.Layer<BusinessCalendarService, never, never> =>
  BusinessCalendarServiceLive.pipe(
    Layer.provide(Layer.succeed(BusinessCalendarConfigService, config)),
  )
