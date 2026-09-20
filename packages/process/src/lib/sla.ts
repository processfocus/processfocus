/**
 * SLA (Service Level Agreement) configuration for Processes and Steps.
 *
 * Durations are expressed in business calendar time (business days/hours/weeks).
 * The actual deadline calculation takes business calendars into account at runtime.
 */

/**
 * Unit of time for SLA durations.
 * All units are based on business calendar time.
 */
export type SlaUnit =
  | "minutes"
  | "businessHours"
  | "businessDays"
  | "businessWeeks"

/**
 * Configuration for an SLA (Service Level Agreement).
 */
export interface SlaConfig {
  /** Duration value (must be a positive integer) */
  readonly value: number
  /** Unit of time */
  readonly unit: SlaUnit
  /**
   * Warning threshold as a percentage (0-100).
   * When this percentage of time has elapsed, status changes to "warning".
   * Default: 80 (warn at 80% elapsed, i.e., 20% remaining)
   */
  readonly warningAt: number
}

/**
 * Options for creating an SLA configuration.
 */
export interface SlaOptions {
  /**
   * Warning threshold as a decimal (0-1).
   * Default: 0.8 (warn at 80% elapsed)
   */
  readonly warningAt?: number
}

const DEFAULT_WARNING_AT = 0.8 // 80%

/**
 * Validates SLA options and returns the warning percentage (0-100).
 */
const validateAndGetWarning = (options?: SlaOptions): number => {
  const warningAt = options?.warningAt ?? DEFAULT_WARNING_AT
  if (warningAt < 0 || warningAt > 1) {
    throw new Error(`SLA warningAt must be between 0 and 1, got ${warningAt}`)
  }
  return Math.round(warningAt * 100)
}

/**
 * Validates that the duration value is a positive integer.
 */
const validateDuration = (value: number, unit: SlaUnit): void => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `SLA ${unit} value must be a positive integer, got ${value}`,
    )
  }
}

/**
 * SLA helper functions for creating SLA configurations.
 *
 * @example
 * ```typescript
 * import { Sla } from "@pf/process"
 *
 * // Duration units (integer values only)
 * sla: Sla.businessHours(4)     // 4 business hours
 * sla: Sla.businessDays(5)      // 5 business days
 * sla: Sla.businessWeeks(2)     // 2 business weeks (10 days)
 *
 * // With warning threshold (optional)
 * sla: Sla.businessDays(5, { warningAt: 0.8 })  // warn at 80% (4 days elapsed)
 * ```
 */
export const Sla = {
  /**
   * Creates an SLA configuration with a duration in minutes.
   * Note: Minutes are clock time, not business calendar time.
   *
   * @param minutes - Number of minutes (positive integer)
   * @param options - Optional configuration (warningAt)
   */
  minutes(minutes: number, options?: SlaOptions): SlaConfig {
    validateDuration(minutes, "minutes")
    return {
      value: minutes,
      unit: "minutes",
      warningAt: validateAndGetWarning(options),
    }
  },

  /**
   * Creates an SLA configuration with a duration in business hours.
   *
   * @param hours - Number of business hours (positive integer)
   * @param options - Optional configuration (warningAt)
   */
  businessHours(hours: number, options?: SlaOptions): SlaConfig {
    validateDuration(hours, "businessHours")
    return {
      value: hours,
      unit: "businessHours",
      warningAt: validateAndGetWarning(options),
    }
  },

  /**
   * Creates an SLA configuration with a duration in business days.
   *
   * @param days - Number of business days (positive integer)
   * @param options - Optional configuration (warningAt)
   */
  businessDays(days: number, options?: SlaOptions): SlaConfig {
    validateDuration(days, "businessDays")
    return {
      value: days,
      unit: "businessDays",
      warningAt: validateAndGetWarning(options),
    }
  },

  /**
   * Creates an SLA configuration with a duration in business weeks.
   * A business week is 5 business days.
   *
   * @param weeks - Number of business weeks (positive integer)
   * @param options - Optional configuration (warningAt)
   */
  businessWeeks(weeks: number, options?: SlaOptions): SlaConfig {
    validateDuration(weeks, "businessWeeks")
    return {
      value: weeks,
      unit: "businessWeeks",
      warningAt: validateAndGetWarning(options),
    }
  },
}
