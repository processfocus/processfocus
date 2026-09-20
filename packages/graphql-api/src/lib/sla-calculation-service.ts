import type { SqlError } from "@effect/sql"
import { Context, Data, DateTime, Effect, Layer } from "effect"
import {
  type BusinessCalendarConfig,
  type BusinessCalendarError,
  BusinessCalendarService,
  makeBusinessCalendarServiceLayer,
} from "@pf/business-calendar"
import {
  BusinessCalendarQueries,
  InvalidCalendarDataError,
  buildCalendarConfig,
  hasCalendarConfigured,
} from "@pf/graphql-db-operations"

// Re-export for consumers that import from this module
export { InvalidCalendarDataError }

/**
 * Error thrown when an invalid SLA unit is encountered in the database.
 *
 * This indicates a data integrity issue - the sla_unit column contains
 * a value that is not one of the valid units (minutes, businessHours,
 * businessDays, businessWeeks).
 */
export class InvalidSlaUnitError extends Data.TaggedError(
  "@pf/InvalidSlaUnitError",
)<{
  readonly executionId: string
  readonly slaUnit: string
}> {}

/**
 * Calculated SLA targets and estimated completion for an execution.
 */
export interface SlaTargets {
  slaTargetAt: string | null
  slaWarningAt: string | null
  estimatedCompletionAt: string | null
}

/**
 * Valid SLA time units.
 */
type SlaUnit = "minutes" | "businessHours" | "businessDays" | "businessWeeks"

/**
 * Check if a string is a valid SLA unit.
 */
const isValidSlaUnit = (unit: string): unit is SlaUnit =>
  unit === "minutes" ||
  unit === "businessHours" ||
  unit === "businessDays" ||
  unit === "businessWeeks"

/**
 * Add clock time (for fallback when no calendar is configured).
 * Converts all units to clock time equivalents (24/7 operation).
 */
const addClockTime = (
  startedAt: DateTime.Utc,
  value: number,
  unit: SlaUnit,
): DateTime.Utc => {
  switch (unit) {
    case "minutes":
      return DateTime.add(startedAt, { minutes: Math.round(value) })
    case "businessHours":
      // Treat as regular hours when no calendar
      return DateTime.add(startedAt, { minutes: Math.round(value * 60) })
    case "businessDays":
      // Treat as 24-hour days when no calendar
      return DateTime.add(startedAt, { hours: Math.round(value * 24) })
    case "businessWeeks":
      // Treat as 7-day weeks when no calendar
      return DateTime.add(startedAt, { hours: Math.round(value * 7 * 24) })
  }
}

/**
 * Input for SLA and estimated completion calculation.
 */
export interface SlaCalculationInput {
  id: string
  startedAt: string
  orgUnitId: string
  slaValue: number | null
  slaUnit: string | null
  slaWarning: number | null
  /** Minimum historical duration in milliseconds */
  typicalDurationMinMs: number | null
  /** Maximum historical duration in milliseconds */
  typicalDurationMaxMs: number | null
}

/**
 * Service for calculating business-calendar-aware SLA targets.
 */
export class SlaCalculationService extends Context.Tag(
  "@pf/graphql-api/SlaCalculationService",
)<
  SlaCalculationService,
  {
    /**
     * Calculate SLA targets for a batch of executions.
     * Returns a map of execution ID to SLA targets.
     *
     * @param executions - Array of execution inputs with SLA configuration
     * @returns Map of execution ID to SLA targets
     */
    readonly calculateSlaTargets: (
      executions: SlaCalculationInput[],
    ) => Effect.Effect<
      Map<string, SlaTargets>,
      | SqlError.SqlError
      | InvalidCalendarDataError
      | InvalidSlaUnitError
      | BusinessCalendarError
    >
  }
>() {}

/**
 * Get number of working days per week from calendar config.
 * Used for businessWeeks calculation.
 */
const getWorkingDaysPerWeek = (config: BusinessCalendarConfig): number => {
  const workDays = new Set(config.weeklySchedule.map((s) => s.day))
  return workDays.size // e.g., 5 for Mon-Fri, 6 for Mon-Sat
}

/**
 * Internal implementation that calculates SLA targets and estimated completion.
 */
const calculateSlaTargetsInternal = (
  calendarQueries: BusinessCalendarQueries["Type"],
) => {
  return (executions: SlaCalculationInput[]) =>
    Effect.gen(function* () {
      const result = new Map<string, SlaTargets>()

      if (executions.length === 0) {
        return result
      }

      // Filter executions that need any calculation (SLA or estimated completion)
      const executionsNeedingCalc = executions.filter(
        (e) =>
          (e.slaValue != null && e.slaUnit != null) ||
          (e.typicalDurationMinMs != null && e.typicalDurationMaxMs != null),
      )

      // For executions without SLA and without typical duration, add null targets
      for (const exec of executions) {
        const hasSla = exec.slaValue != null && exec.slaUnit != null
        const hasDuration =
          exec.typicalDurationMinMs != null && exec.typicalDurationMaxMs != null
        if (!hasSla && !hasDuration) {
          result.set(exec.id, {
            slaTargetAt: null,
            slaWarningAt: null,
            estimatedCompletionAt: null,
          })
        }
      }

      if (executionsNeedingCalc.length === 0) {
        return result
      }

      // Collect unique org unit IDs
      const orgUnitIds = [
        ...new Set(executionsNeedingCalc.map((e) => e.orgUnitId)),
      ]

      // Load calendar data for all org units
      const calendarDataMap = yield* calendarQueries.getCalendarData(orgUnitIds)

      // For org units without calendar, try to find root org unit with calendar
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

      // Group executions by org unit to reuse calendar layers
      const byOrgUnit = new Map<string, SlaCalculationInput[]>()
      for (const exec of executionsNeedingCalc) {
        const list = byOrgUnit.get(exec.orgUnitId) ?? []
        list.push(exec)
        byOrgUnit.set(exec.orgUnitId, list)
      }

      // Process each org unit with one shared layer
      for (const [orgUnitId, execs] of byOrgUnit) {
        const calendarData = calendarDataMap.get(orgUnitId)

        if (!calendarData || !hasCalendarConfigured(calendarData)) {
          // No calendar configured - use clock time (24/7 operation)
          for (const exec of execs) {
            const targets = yield* calculateWithClockTime(exec)
            result.set(exec.id, targets)
          }
          continue
        }

        // Build config and layer once per org unit
        const config = yield* buildCalendarConfig(calendarData)
        const layer = makeBusinessCalendarServiceLayer(config)
        const workingDaysPerWeek = getWorkingDaysPerWeek(config)

        // Calculate targets for all executions in this org unit
        for (const exec of execs) {
          const targets = yield* calculateWithCalendar(
            exec,
            workingDaysPerWeek,
          ).pipe(Effect.provide(layer))

          result.set(exec.id, targets)
        }
      }

      return result
    })
}

/**
 * Add business time based on SLA unit.
 */
const addBusinessTime = (
  calendarService: BusinessCalendarService["Type"],
  startedAt: DateTime.Utc,
  value: number,
  unit: SlaUnit,
  workingDaysPerWeek: number,
): Effect.Effect<DateTime.Utc, BusinessCalendarError, never> => {
  switch (unit) {
    case "minutes":
      // Convert minutes to hours for addBusinessHours
      return calendarService.addBusinessHours(startedAt, value / 60)
    case "businessHours":
      return calendarService.addBusinessHours(startedAt, value)
    case "businessDays":
      return calendarService.addBusinessDays(startedAt, value)
    case "businessWeeks":
      // Business weeks = working days per week * value
      return calendarService.addBusinessDays(
        startedAt,
        value * workingDaysPerWeek,
      )
  }
}

/**
 * Calculate SLA targets using clock time (no business calendar).
 * Used when org unit has no business calendar configured (24/7 operation).
 */
const calculateWithClockTime = (
  exec: SlaCalculationInput,
): Effect.Effect<SlaTargets, InvalidSlaUnitError> =>
  Effect.gen(function* () {
    const startedAt = DateTime.unsafeMake(exec.startedAt)
    const hasSla = exec.slaValue != null && exec.slaUnit != null

    let slaTargetAt: string | null = null
    let slaWarningAt: string | null = null

    if (hasSla) {
      const slaValue = exec.slaValue as number
      const unitStr = exec.slaUnit as string

      if (!isValidSlaUnit(unitStr)) {
        return yield* new InvalidSlaUnitError({
          executionId: exec.id,
          slaUnit: unitStr,
        })
      }
      const slaUnit = unitStr

      const slaTarget = addClockTime(startedAt, slaValue, slaUnit)
      slaTargetAt = DateTime.formatIso(slaTarget)

      if (exec.slaWarning != null) {
        const warningFraction = exec.slaWarning / 100
        const warningValue = slaValue * warningFraction
        const warningTarget = addClockTime(startedAt, warningValue, slaUnit)
        slaWarningAt = DateTime.formatIso(warningTarget)
      }
    }

    // Calculate estimated completion using clock time
    let estimatedCompletionAt: string | null = null
    if (
      exec.typicalDurationMinMs != null &&
      exec.typicalDurationMaxMs != null
    ) {
      const midpointMs =
        (exec.typicalDurationMinMs + exec.typicalDurationMaxMs) / 2
      const estimatedTarget = DateTime.add(startedAt, {
        millis: Math.round(midpointMs),
      })
      estimatedCompletionAt = DateTime.formatIso(estimatedTarget)
    }

    return {
      slaTargetAt,
      slaWarningAt,
      estimatedCompletionAt,
    }
  })

/**
 * Calculate SLA targets using business calendar.
 */
const calculateWithCalendar = (
  exec: SlaCalculationInput,
  workingDaysPerWeek: number,
): Effect.Effect<
  SlaTargets,
  InvalidSlaUnitError | BusinessCalendarError,
  BusinessCalendarService
> =>
  Effect.gen(function* () {
    const calendarService = yield* BusinessCalendarService

    const startedAt = DateTime.unsafeMake(exec.startedAt)
    const hasSla = exec.slaValue != null && exec.slaUnit != null

    // Calculate SLA target only if SLA is configured
    let slaTargetAt: string | null = null
    let slaWarningAt: string | null = null

    if (hasSla) {
      const slaValue = exec.slaValue as number
      // exec.slaUnit is guaranteed non-null here due to hasSla check
      const unitStr = exec.slaUnit as string

      if (!isValidSlaUnit(unitStr)) {
        return yield* new InvalidSlaUnitError({
          executionId: exec.id,
          slaUnit: unitStr,
        })
      }
      const slaUnit = unitStr

      // Calculate SLA target based on unit
      const slaTarget = yield* addBusinessTime(
        calendarService,
        startedAt,
        slaValue,
        slaUnit,
        workingDaysPerWeek,
      )
      slaTargetAt = DateTime.formatIso(slaTarget)

      // Calculate warning time at warningPercent of the way through
      if (exec.slaWarning != null) {
        const warningFraction = exec.slaWarning / 100
        const warningValue = slaValue * warningFraction
        const warningTarget = yield* addBusinessTime(
          calendarService,
          startedAt,
          warningValue,
          slaUnit,
          workingDaysPerWeek,
        )
        slaWarningAt = DateTime.formatIso(warningTarget)
      }
    }

    // Calculate estimated completion using business hours
    let estimatedCompletionAt: string | null = null
    // typicalDurationMinMs/MaxMs are business-hours durations from completed executions.
    // They come from the business_duration column on process_execution, which is
    // calculated and stored when an execution completes (using the business calendar
    // to convert wallclock time to business hours, or wallclock time if no calendar).
    if (
      exec.typicalDurationMinMs != null &&
      exec.typicalDurationMaxMs != null
    ) {
      const midpointMs =
        (exec.typicalDurationMinMs + exec.typicalDurationMaxMs) / 2
      // Convert business milliseconds to business hours for addBusinessHours API
      const durationHours = midpointMs / (60 * 60 * 1000)
      const estimatedTarget = yield* calendarService.addBusinessHours(
        startedAt,
        durationHours,
      )
      estimatedCompletionAt = DateTime.formatIso(estimatedTarget)
    }

    return {
      slaTargetAt,
      slaWarningAt,
      estimatedCompletionAt,
    }
  })

/**
 * Live implementation of SlaCalculationService.
 * Errors propagate up - no silent fallbacks.
 */
export const SlaCalculationServiceLive = Layer.effect(
  SlaCalculationService,
  Effect.gen(function* () {
    const calendarQueries = yield* BusinessCalendarQueries

    return {
      calculateSlaTargets: calculateSlaTargetsInternal(calendarQueries),
    }
  }),
)
