import { Context, DateTime, Effect, Layer } from "effect"
import {
  AllDays,
  type BusinessCalendarConfig,
  type CalendarPeriod,
  type DayOfWeek,
  type DaySchedule,
  type Holiday,
  type TimestampPair,
  calculateBusinessDurations,
  calculateRawDurations,
  makeBusinessCalendarService,
} from "@pf/business-calendar"
import {
  BusinessCalendarQueries,
  DEFAULT_DURATION_SAMPLE_SIZE,
  ExecutionDurationQueries,
  type OrgUnitCalendarData,
} from "@pf/graphql-db-operations"

/**
 * Duration statistics for a process.
 */
interface ProcessDurationStats {
  minBusinessDurationMs: number | null
  maxBusinessDurationMs: number | null
}

/**
 * Service for calculating business-hours-aware process durations.
 */
export class ProcessDurationService extends Context.Tag(
  "@pf/graphql-api/ProcessDurationService",
)<
  ProcessDurationService,
  {
    /**
     * Calculate business-hours durations for a list of processes.
     * Returns a map of process ID to duration statistics.
     *
     * @param processes - Array of {id, orgUnitId} pairs
     * @returns Map of process ID to business duration stats
     */
    readonly calculateDurations: (
      processes: Array<{ id: string; orgUnitId: string }>,
    ) => Effect.Effect<Map<string, ProcessDurationStats>>
  }
>() {}

/**
 * Build BusinessCalendarConfig from database data.
 */
const buildCalendarConfig = (
  data: OrgUnitCalendarData,
): BusinessCalendarConfig => {
  // Build weekly schedule from rows
  const weeklySchedule: DaySchedule[] = data.weeklySchedule.map((row) => ({
    day: row.dayOfWeek as DayOfWeek,
    ranges: row.timeRanges,
  }))

  // Build holidays from rules
  const holidays: Holiday[] = data.holidays
    .map((row) => row.holidayRule as Holiday)
    .filter((h): h is Holiday => h !== null && h !== undefined)

  // Build date exceptions
  const exceptions = data.dateExceptions.map((row) => ({
    date: DateTime.unsafeMake(row.exceptionDate),
    slots: row.exceptionSlots,
    note: row.exceptionNote,
  }))

  // Build periods
  const periods: CalendarPeriod[] = data.periods.map((row) => ({
    id: `${row.orgUnitId}-${row.periodKind}-${row.periodTitle}`,
    name: row.periodTitle,
    type: row.periodKind,
    startDate: DateTime.unsafeMake(row.periodStart),
    endDate: DateTime.unsafeMake(row.periodEnd),
    isActive: row.periodActive,
    weeklySchedule: row.periodSchedule as DaySchedule[] | undefined,
  }))

  // Determine non-working days from absence in weekly schedule
  const workDays = new Set(weeklySchedule.map((s) => s.day))
  const nonWorkingDays = AllDays.filter((day) => !workDays.has(day))

  return {
    weeklySchedule,
    holidays,
    exceptions,
    nonWorkingDays,
    periods,
  }
}

/**
 * Check if calendar data has any schedule configured.
 */
const hasCalendarConfigured = (data: OrgUnitCalendarData): boolean =>
  data.weeklySchedule.length > 0

/**
 * Internal implementation that may fail with SqlError.
 * Curried so the queries are closed over once; the returned function is traced.
 */
const calculateDurationsInternal = (
  durationQueries: ExecutionDurationQueries["Type"],
  calendarQueries: BusinessCalendarQueries["Type"],
) =>
  Effect.fn("ProcessDurationService.calculateDurations")(function* (
    processes: Array<{ id: string; orgUnitId: string }>,
  ) {
    if (processes.length === 0) {
      return new Map<string, ProcessDurationStats>()
    }

    const processIds = processes.map((p) => p.id)
    const orgUnitIds = [...new Set(processes.map((p) => p.orgUnitId))]

    // 1. Fetch execution timestamps
    const timestamps = yield* durationQueries.getExecutionTimestamps(
      processIds,
      DEFAULT_DURATION_SAMPLE_SIZE,
    )

    if (timestamps.length === 0) {
      // No completed executions, return null durations
      const result = new Map<string, ProcessDurationStats>()
      for (const process of processes) {
        result.set(process.id, {
          minBusinessDurationMs: null,
          maxBusinessDurationMs: null,
        })
      }
      return result
    }

    // 2. Load calendar data for all org units
    const calendarDataMap = yield* calendarQueries.getCalendarData(orgUnitIds)

    // 3. For org units without calendar, try to find parent with calendar
    const orgUnitsNeedingFallback = orgUnitIds.filter((id) => {
      const data = calendarDataMap.get(id)
      return !data || !hasCalendarConfigured(data)
    })

    if (orgUnitsNeedingFallback.length > 0) {
      const rootOrgUnitId = yield* calendarQueries.getRootOrgUnit()

      if (rootOrgUnitId && !calendarDataMap.has(rootOrgUnitId)) {
        const rootCalendarData = yield* calendarQueries.getCalendarData([
          rootOrgUnitId,
        ])
        const rootData = rootCalendarData.get(rootOrgUnitId)

        if (rootData && hasCalendarConfigured(rootData)) {
          for (const orgUnitId of orgUnitsNeedingFallback) {
            calendarDataMap.set(orgUnitId, rootData)
          }
        }
      } else if (rootOrgUnitId) {
        const rootData = calendarDataMap.get(rootOrgUnitId)
        if (rootData && hasCalendarConfigured(rootData)) {
          for (const orgUnitId of orgUnitsNeedingFallback) {
            calendarDataMap.set(orgUnitId, rootData)
          }
        }
      }
    }

    // 4. Group timestamps by org unit
    const timestampsByOrgUnit = new Map<string, TimestampPair[]>()
    for (const ts of timestamps) {
      const pairs = timestampsByOrgUnit.get(ts.orgUnitId) ?? []
      pairs.push({
        id: ts.processId,
        createdAt: ts.createdAt,
        finishedAt: ts.finishedAt,
      })
      timestampsByOrgUnit.set(ts.orgUnitId, pairs)
    }

    // 5. Calculate durations for each org unit using its calendar
    const allStats = new Map<string, ProcessDurationStats>()

    for (const [orgUnitId, pairs] of timestampsByOrgUnit) {
      const calendarData = calendarDataMap.get(orgUnitId)

      if (calendarData && hasCalendarConfigured(calendarData)) {
        // Use business calendar
        const config = buildCalendarConfig(calendarData)
        const calendarService = yield* makeBusinessCalendarService(config)

        const stats = yield* calculateBusinessDurations(calendarService, pairs)

        for (const [id, stat] of stats) {
          allStats.set(id, {
            minBusinessDurationMs: stat.minBusinessDurationMs,
            maxBusinessDurationMs: stat.maxBusinessDurationMs,
          })
        }
      } else {
        // No calendar configured, fall back to wall-clock time
        const stats = calculateRawDurations(pairs)

        for (const [id, stat] of stats) {
          allStats.set(id, {
            minBusinessDurationMs: stat.minBusinessDurationMs,
            maxBusinessDurationMs: stat.maxBusinessDurationMs,
          })
        }
      }
    }

    // 6. Fill in null for processes without executions
    for (const process of processes) {
      if (!allStats.has(process.id)) {
        allStats.set(process.id, {
          minBusinessDurationMs: null,
          maxBusinessDurationMs: null,
        })
      }
    }

    return allStats
  })

/**
 * Live implementation of ProcessDurationService.
 * Catches SQL errors and returns empty durations as fallback.
 */
export const ProcessDurationServiceLive = Layer.effect(
  ProcessDurationService,
  Effect.gen(function* () {
    const durationQueries = yield* ExecutionDurationQueries
    const calendarQueries = yield* BusinessCalendarQueries

    const calculateDurationsImpl = calculateDurationsInternal(
      durationQueries,
      calendarQueries,
    )

    return {
      calculateDurations: (processes) =>
        calculateDurationsImpl(processes).pipe(
          // On SQL error, fall back to null durations (log like sibling fallbacks)
          Effect.tapError((error) =>
            Effect.logWarning("Falling back to null process durations", {
              error,
            }),
          ),
          Effect.catchAll(() => {
            const result = new Map<string, ProcessDurationStats>()
            for (const process of processes) {
              result.set(process.id, {
                minBusinessDurationMs: null,
                maxBusinessDurationMs: null,
              })
            }
            return Effect.succeed(result)
          }),
        ),
    }
  }),
)
