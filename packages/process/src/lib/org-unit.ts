import { Construct } from "constructs"

/**
 * Type of organizational unit.
 *
 * - organisation: The root organizational unit (only for Organisation class)
 * - board: Top-level governing body
 * - division: Large organizational division
 * - department: Standard department
 * - team: Small team within a department
 * - unit: Generic organizational unit
 * - other: Other types of organizational entities
 */
export type OrgUnitType =
  | "organisation"
  | "board"
  | "division"
  | "department"
  | "team"
  | "unit"
  | "other"

export interface OrgUnitProps {
  /**
   * Full name of organisation or department.
   */
  readonly name: string

  readonly type?: OrgUnitType

  /** Optional shortened form of the name (e.g., "IT" for "Information Technology") */
  readonly acronym?: string | undefined
}

/**
 * Represents an organizational unit within the hierarchy.
 *
 * Organizational units form a strict tree hierarchy where each unit
 * has exactly one parent (except the root Organisation). They provide
 * scoping for processes and roles.
 *
 * Note: The type "organisation" is reserved for the root Organisation
 * class and cannot be used when creating regular OrgUnit instances.
 *
 * @example
 * ```typescript
 * const org = new Organisation({ name: "Acme Corp" })
 * const board = new OrgUnit(org, "board", {
 *   name: "Board of Directors",
 *   type: "board"
 * })
 *
 * const finance = new OrgUnit(board, "finance", {
 *   name: "Finance Department",
 *   type: "department"
 * })
 * ```
 */
export class OrgUnit extends Construct {
  readonly isOrgUnit: true = true
  readonly name: string
  readonly type?: OrgUnitType
  readonly acronym?: string | undefined

  constructor(scope: OrgUnit, id: string, props: OrgUnitProps) {
    // Prevent users from creating OrgUnit with type "organisation"
    // Only allow it when scope is null (called from Organisation constructor)
    if (props.type === "organisation" && scope !== null) {
      throw new Error(
        "Cannot create OrgUnit with type 'organisation'. Use Organisation class instead.",
      )
    }

    super(scope, id)
    this.name = props.name
    if (props.type !== undefined) {
      this.type = props.type
    }
    if (props.acronym !== undefined) {
      this.acronym = props.acronym
    }
  }
}
