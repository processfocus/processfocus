/**
 * Type definitions for extracting organisation data for database storage.
 */

import type { SlaUnit } from "@pf/process"

/**
 * Represents the complete organisation structure extracted for database storage.
 * The root org unit represents the organisation itself with its hierarchical structure.
 */
export interface ExtractedOrgData {
  name: string
  rootOrgUnit: ExtractedOrgUnitData
  /** Weekly schedule entries from businessCalendar (applied to root org unit) */
  weeklySchedule: ExtractedWeeklyScheduleData[]
  /** Holiday rules from businessCalendar (applied to root org unit) */
  holidayRules: ExtractedHolidayRuleData[]
}

/**
 * Represents an organizational unit (department, division, etc.) in a hierarchical structure.
 *
 * Note: processes and roles are for this org unit level only, not descendants.
 * Child org units are represented in the children array.
 */
export interface ExtractedOrgUnitData {
  name: string
  orgUnitLevel: string
  path: string
  parentOrgUnitPath?: string | undefined
  /** Optional shortened form of the name (e.g., "IT" for "Information Technology") */
  acronym?: string | undefined
  /** IANA timezone identifier (e.g., "Europe/Amsterdam"). Inherited from root organisation. */
  timezone: string
  /** First day of business week (0=Sunday, 6=Saturday). Inherited from root organisation. */
  startDayOfWeek?: number | undefined
  /** Processes belonging to this org unit only (not descendants) */
  processes: ExtractedProcessData[]
  /** Roles belonging to this org unit only (not descendants) */
  roles: ExtractedRoleData[]
  /** Child organizational units */
  children: ExtractedOrgUnitData[]
}

/**
 * Represents extracted SLA (Service Level Agreement) configuration.
 */
export interface ExtractedSlaData {
  /** Duration value (positive integer) */
  value: number
  /** Unit of time: "businessHours" | "businessDays" | "businessWeeks" */
  unit: SlaUnit
  /** Warning threshold percentage (0-100) */
  warningAt: number
}

/**
 * Represents a single process with all its associated data.
 */
export interface ExtractedProcessData {
  orgUnitPath: string
  name: string
  path: string
  purpose: string
  steps: ExtractedStepData[]
  flows: ExtractedFlowData[]
  responsibilities: ExtractedRoleResponsibilityData[]
  /** Phases belonging to this process, ordered by appearance */
  phases: ExtractedPhaseData[]
  /** Optional SLA for the overall process */
  sla?: ExtractedSlaData
}

/**
 * Represents a role that can execute steps.
 */
export interface ExtractedRoleData {
  orgUnitPath: string
  name: string
  path: string
}

/**
 * Represents a step within a process.
 */
export interface ExtractedStepData {
  name: string
  purpose: string
  processPath: string
  /**
   * Role that executes this step.
   * Undefined for system steps (SystemStep) which have no role.
   */
  rolePath?: string
  /** Additional roles that can also complete this form step. */
  supportingRolePaths?: string[]
  path: string
  /** Number of form fields (only for Form steps) */
  formFields?: number
  /** Optional phase that this step belongs to */
  phasePath?: string
  /** Optional SLA for this step */
  sla?: ExtractedSlaData
  /** Whether this step uses forEach semantics (multi-instance) */
  hasForEach?: boolean
  /** Whether this step is intentionally embeddable as an anonymous start form */
  embedded?: boolean
  /** Maximum retry attempts for system steps: 0 = no retries, undefined = use system default */
  retryLimit?: number
  /** Paths of document stores referenced by this step's form (for authorization) */
  documentStoreReferences?: string[]
}

/**
 * Represents a flow (connection) between two steps.
 */
export interface ExtractedFlowData {
  sourceStepPath: string
  targetStepPath: string
  /** Human-readable description of the condition, if this is a conditional flow */
  condition?: string
  /** Human-readable description of the schedule, if this is a scheduled flow */
  schedule?: string
  /** Whether this is an else/fallback branch (taken when no conditional flows match) */
  isElse: boolean
  /** Whether this flow runs after a terminal system-step failure */
  isOnError: boolean
  /** Optional case-sensitive outer error tags this error branch matches */
  taggedErrors: readonly string[] | null
}

/**
 * Represents an invitation for a user to join the organisation with pre-assigned roles.
 */
export interface ExtractedInvitationData {
  /** Unique identifier from the construct id */
  id: string
  /** Email address of the invited user */
  email: string
  /** Role paths to assign when the user accepts */
  rolePaths: readonly string[]
}

/**
 * Represents a phase that groups steps visually in a process workflow.
 * Phases are process-specific and have an explicit display order.
 */
export interface ExtractedPhaseData {
  processPath: string
  name: string
  path: string
  /** Display order within the process (1-based) */
  order: number
}

/**
 * Represents a role's responsibility in a specific process.
 */
export interface ExtractedRoleResponsibilityData {
  processPath: string
  rolePath: string
  responsibility: string
  /** Display order within the process (1-based) */
  order: number
}

/**
 * Represents a weekly schedule entry for a specific day of week.
 * Extracted from BusinessCalendarConfig.weeklySchedule.
 */
export interface ExtractedWeeklyScheduleData {
  orgUnitPath: string
  /** Day of week (0=Sunday, 6=Saturday) */
  dayOfWeek: number
  /** Time ranges for this day - when the org is open */
  timeRanges: Array<{
    open: { hour: number; minute: number }
    close: { hour: number; minute: number }
  }>
}

/**
 * Represents a holiday rule to be stored in the database.
 * Extracted from BusinessCalendarConfig.holidays.
 */
export interface ExtractedHolidayRuleData {
  orgUnitPath: string
  /** Holiday name/title */
  name: string
  /** The rule definition (FixedHoliday, NthWeekdayHoliday, etc.) as JSON */
  rule: Record<string, unknown>
}

/**
 * Represents a document store configuration for file uploads.
 * Extracted from DocumentStore constructs in the organisation.
 */
export interface ExtractedDocumentStoreData {
  orgUnitPath: string
  name: string
  path: string
  acceptedTypes?: string[]
  maxFileSize?: number
}
