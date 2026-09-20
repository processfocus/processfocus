import { DateTime, Duration, Effect } from "effect"
import type {
  BusinessCalendarError,
  BusinessCalendarServiceShape,
} from "./calendar-service.js"

/**
 * Timestamp pair from a completed execution.
 */
export interface TimestampPair {
  /** Identifier for grouping (e.g., processId) */
  id: string
  /** Start time in epoch milliseconds */
  createdAt: number
  /** Finish time in epoch milliseconds */
  finishedAt: number
}

/**
 * Duration statistics for a group of timestamp pairs.
 */
export interface DurationStats {
  /** The identifier (e.g., processId) */
  id: string
  /** Minimum business-hours duration in milliseconds, null if no samples */
  minBusinessDurationMs: number | null
  /** Maximum business-hours duration in milliseconds, null if no samples */
  maxBusinessDurationMs: number | null
}

/**
 * Calculate business-hours duration for a single timestamp pair.
 * Uses a resolved BusinessCalendarService shape (no ambient service tag).
 */
export const calculateBusinessDuration = (
  calendarService: BusinessCalendarServiceShape,
  createdAt: number,
  finishedAt: number,
): Effect.Effect<Duration.Duration, BusinessCalendarError, never> =>
  Effect.gen(function* () {
    const start = DateTime.unsafeMake(createdAt)
    const end = DateTime.unsafeMake(finishedAt)

    return yield* calendarService.businessHoursBetween(start, end)
  })

/** Bounded concurrency for independent business-hours pair calculations. */
const DURATION_CALC_CONCURRENCY = 16

/**
 * Calculate business-hours duration for multiple timestamp pairs.
 * Groups by id and returns min/max statistics for each group.
 *
 * Independent pairs are evaluated with bounded concurrency; min/max
 * aggregation is order-independent.
 *
 * @param calendarService - Resolved calendar service for the org unit
 * @param timestampPairs - Array of timestamp pairs with their grouping id
 * @returns Map of id to duration statistics
 */
export const calculateBusinessDurations = (
  calendarService: BusinessCalendarServiceShape,
  timestampPairs: readonly TimestampPair[],
): Effect.Effect<Map<string, DurationStats>, BusinessCalendarError, never> =>
  Effect.gen(function* () {
    if (timestampPairs.length === 0) {
      return new Map()
    }

    // Compute each pair independently (order does not matter for min/max).
    const pairDurations = yield* Effect.forEach(
      timestampPairs,
      (pair) =>
        Effect.gen(function* () {
          const start = DateTime.unsafeMake(pair.createdAt)
          const end = DateTime.unsafeMake(pair.finishedAt)
          const duration = yield* calendarService.businessHoursBetween(
            start,
            end,
          )
          return {
            id: pair.id,
            durationMs: Duration.toMillis(duration),
          }
        }),
      { concurrency: DURATION_CALC_CONCURRENCY },
    )

    // Aggregate min/max per id (order-independent)
    const aggregates = new Map<string, { min: number; max: number }>()

    for (const { id, durationMs } of pairDurations) {
      const existing = aggregates.get(id)
      if (!existing) {
        aggregates.set(id, { min: durationMs, max: durationMs })
      } else {
        existing.min = Math.min(existing.min, durationMs)
        existing.max = Math.max(existing.max, durationMs)
      }
    }

    const result = new Map<string, DurationStats>()
    for (const [id, { min, max }] of aggregates) {
      result.set(id, {
        id,
        minBusinessDurationMs: min,
        maxBusinessDurationMs: max,
      })
    }

    return result
  })

/**
 * Calculate raw (wall-clock) duration for multiple timestamp pairs.
 * This is a fallback when no business calendar is configured.
 *
 * @param timestampPairs - Array of timestamp pairs with their grouping id
 * @returns Map of id to duration statistics (using wall-clock time)
 */
export const calculateRawDurations = (
  timestampPairs: readonly TimestampPair[],
): Map<string, DurationStats> => {
  if (timestampPairs.length === 0) {
    return new Map()
  }

  // Group pairs by id
  const groupedPairs = new Map<string, TimestampPair[]>()
  for (const pair of timestampPairs) {
    const existing = groupedPairs.get(pair.id)
    if (existing) {
      existing.push(pair)
    } else {
      groupedPairs.set(pair.id, [pair])
    }
  }

  // Calculate durations for each group
  const result = new Map<string, DurationStats>()

  for (const [id, pairs] of groupedPairs) {
    const durations = pairs.map((p) => p.finishedAt - p.createdAt)

    if (durations.length === 0) {
      result.set(id, {
        id,
        minBusinessDurationMs: null,
        maxBusinessDurationMs: null,
      })
    } else {
      result.set(id, {
        id,
        minBusinessDurationMs: Math.min(...durations),
        maxBusinessDurationMs: Math.max(...durations),
      })
    }
  }

  return result
}
