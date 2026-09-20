import type { IConstruct } from "constructs"
import type { BusinessCalendarConfig } from "@pf/business-calendar"
import {
  isDocumentStore,
  isForm,
  isList,
  isOrgUnit,
  isProcess,
  isStatsView,
  isStep,
} from "./brands"
import type { DocumentStore } from "./document-store"
import type { Form } from "./form"
import type { List } from "./list"
import { type OrgUnit, OrgUnit as OrgUnitClass } from "./org-unit"
import { type Process, Process as ProcessClass } from "./process"
import type { StatsView } from "./stats-view"
import type { Step } from "./step"

/**
 * Set of valid IANA timezone identifiers.
 * Cached for performance.
 * Note: "UTC" is valid for Intl.DateTimeFormat but not in supportedValuesOf,
 * so we add it explicitly.
 */
const validTimeZones = new Set([...Intl.supportedValuesOf("timeZone"), "UTC"])

/**
 * Validates that a string is a valid IANA timezone identifier.
 * @throws Error if timezone is invalid
 */
export const validateTimeZone = (timeZone: string): void => {
  if (!validTimeZones.has(timeZone)) {
    throw new Error(
      `Invalid timezone: "${timeZone}". Must be a valid IANA timezone identifier (e.g., "Europe/Amsterdam", "America/New_York").`,
    )
  }
}

/**
 * This Organisation is purely for internal use (testing).
 *
 * The real organisation lives in the organisation package, and has
 * various helper methods to use it.
 */

export interface OrganisationProps {
  /**
   * Full name of organisation.
   */
  readonly name: string

  /**
   * Shortened form.
   */
  readonly acronym?: string | undefined

  /**
   * IANA timezone identifier (e.g., "Europe/Amsterdam", "America/New_York").
   * Defaults to "UTC" if not specified.
   */
  readonly timeZone?: string | undefined

  /**
   * BCP 47 locale used for organisation-authored date/time display.
   */
  readonly locale?: string | undefined

  /**
   * Business calendar configuration for the organisation.
   * Defines working hours, holidays, and special periods.
   *
   * Behaviour: default is to be closed, the business calendar specifies when the
   * business is operating.
   *
   * Default when no calendar is specified: a 24/7 calendar.
   */
  readonly businessCalendar?: BusinessCalendarConfig | undefined
}

/**
 * Represents the root organizational unit.
 *
 * Organisation extends OrgUnit and is automatically assigned type "organisation".
 * It serves as the root of the organizational hierarchy tree.
 *
 * @example
 * ```typescript
 * const org = new Organisation({
 *   name: "Acme Corp",
 *   timeZone: "Europe/Amsterdam"
 * })
 * const hr = new OrgUnit(org, "hr", {
 *   name: "Human Resources",
 *   type: "department"
 * })
 * ```
 */
export class Organisation extends OrgUnitClass {
  readonly isOrganisation: true = true
  /**
   * IANA timezone identifier (e.g., "Europe/Amsterdam", "America/New_York").
   */
  readonly timeZone: string

  /**
   * BCP 47 locale used for organisation-authored date/time display.
   */
  readonly locale: string

  /**
   * Business calendar configuration for the organisation.
   * Defines working hours, holidays, and special periods.
   */
  readonly businessCalendar?: BusinessCalendarConfig | undefined

  constructor(props: OrganisationProps) {
    const timeZone = props.timeZone ?? "UTC"
    validateTimeZone(timeZone)

    // Pass null as scope (root has no parent), empty ID,
    // and type "organisation".
    super(null as unknown as OrgUnit, "", {
      name: props.name,
      type: "organisation",
      ...(props.acronym !== undefined && { acronym: props.acronym }),
    })
    this.timeZone = timeZone
    this.locale = props.locale ?? "en"
    this.businessCalendar = props.businessCalendar
  }

  /**
   * Find a step by its path relative to the organisation root.
   * Path format: "orgUnit/processName/stepName"
   *
   * @param stepPath - Path like "engineering/bug-report-fix/Report bug"
   * @returns The Step if found, otherwise undefined
   *
   * @example
   * ```ts
   * const step = org.stepByPath("engineering/bug-report-fix/Report bug")
   * if (step) {
   *   // Handle step
   * }
   * ```
   */
  stepByPath(stepPath: string): Step | undefined {
    const segments = stepPath.split("/").filter((segment) => segment.length > 0)

    let currentNode: IConstruct = this

    for (const segment of segments) {
      try {
        currentNode = currentNode.node.findChild(segment)
      } catch {
        // Child not found
        return undefined
      }
    }

    return isStep(currentNode) ? currentNode : undefined
  }

  /**
   * Find a Form step by its path relative to the organisation root.
   * Returns undefined if the path doesn't exist or points to a non-Form step.
   *
   * @param stepPath - Path like "engineering/bug-report-fix/Report bug"
   * @returns The Form if found, otherwise undefined
   */
  formByPath(stepPath: string): Form | undefined {
    const step = this.stepByPath(stepPath)
    return isForm(step) ? step : undefined
  }

  /**
   * Recursively collects all processes from this organisation.
   *
   * @returns Array of all Process instances in the organisation tree
   */
  processes(): Process[] {
    const result: Process[] = []
    const stack: OrgUnit[] = [this]

    while (stack.length > 0) {
      const current = stack.pop()
      if (current) {
        for (const child of current.node.children) {
          if (isOrgUnit(child)) {
            stack.push(child)
          } else if (isProcess(child)) {
            result.push(child)
          }
        }
      }
    }

    return result
  }

  /**
   * Recursively collects all lists from this organisation.
   *
   * @returns Array of all List instances in the organisation tree
   */
  // biome-ignore lint/suspicious/noExplicitAny: List generics erased at runtime
  lists(): List<any, any, any, any, any, any>[] {
    // biome-ignore lint/suspicious/noExplicitAny: List generics erased at runtime
    const result: List<any, any, any, any, any, any>[] = []
    const stack: OrgUnit[] = [this]

    while (stack.length > 0) {
      const current = stack.pop()
      if (current) {
        for (const child of current.node.children) {
          if (isOrgUnit(child)) {
            stack.push(child)
          } else if (isList(child)) {
            result.push(child as (typeof result)[number])
          }
        }
      }
    }

    return result
  }

  /**
   * Recursively collects all document stores from this organisation.
   *
   * @returns Array of all DocumentStore instances in the organisation tree
   */
  documentStores(): DocumentStore[] {
    const result: DocumentStore[] = []
    const stack: OrgUnit[] = [this]

    while (stack.length > 0) {
      const current = stack.pop()
      if (current) {
        for (const child of current.node.children) {
          if (isOrgUnit(child)) {
            stack.push(child)
          } else if (isDocumentStore(child)) {
            result.push(child)
          }
        }
      }
    }

    return result
  }

  /**
   * Recursively collects all stats views from this organisation.
   *
   * @returns Array of all StatsView instances in the organisation tree
   */
  statsViews(): StatsView[] {
    const result: StatsView[] = []
    const stack: OrgUnit[] = [this]

    while (stack.length > 0) {
      const current = stack.pop()
      if (current) {
        for (const child of current.node.children) {
          if (isOrgUnit(child)) {
            stack.push(child)
          } else if (isStatsView(child)) {
            result.push(child)
          }
        }
      }
    }

    return result
  }

  /**
   * Find a List by its path relative to the organisation root.
   * Path format: "orgUnit/listName" (e.g., "school/employees")
   *
   * @param listPath - Path to the list
   * @returns The List if found, otherwise undefined
   *
   * @example
   * ```ts
   * const list = org.listByPath("school/employees")
   * if (list) {
   *   // Use the list
   * }
   * ```
   */
  // biome-ignore lint/suspicious/noExplicitAny: List generics erased at runtime
  listByPath(listPath: string): List<any, any, any, any, any, any> | undefined {
    const segments = listPath.split("/").filter((segment) => segment.length > 0)

    let currentNode: IConstruct = this

    for (const segment of segments) {
      try {
        currentNode = currentNode.node.findChild(segment)
      } catch {
        // Child not found
        return undefined
      }
    }

    return isList(currentNode)
      ? (currentNode as NonNullable<ReturnType<Organisation["listByPath"]>>)
      : undefined
  }

  /**
   * Returns true if the node ID is the virtual end node (__end__).
   * Used when walking process graphs to skip the end node.
   */
  isEndNode(nodeId: string): boolean {
    return nodeId === ProcessClass.END_NODE
  }

  /**
   * Validates all process flows in the organisation.
   * A flow is valid if all non-virtual nodes are reachable and have an edge to the end node.
   *
   * @returns Array of validation errors with process path and problem details
   */
  validateAllFlows(): Array<{
    processPath: string
    unreachable: string[]
    dangling: string[]
    missingElse: string[]
    multipleElse: string[]
    orphanElse: string[]
  }> {
    const results: Array<{
      processPath: string
      unreachable: string[]
      dangling: string[]
      missingElse: string[]
      multipleElse: string[]
      orphanElse: string[]
    }> = []
    for (const process of this.processes()) {
      const { unreachable, dangling, missingElse, multipleElse, orphanElse } =
        process.validateFlows()
      if (
        unreachable.length > 0 ||
        dangling.length > 0 ||
        missingElse.length > 0 ||
        multipleElse.length > 0 ||
        orphanElse.length > 0
      ) {
        results.push({
          processPath: process.node.path,
          unreachable,
          dangling,
          missingElse,
          multipleElse,
          orphanElse,
        })
      }
    }
    return results
  }
}
