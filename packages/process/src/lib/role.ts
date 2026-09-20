import { Construct } from "constructs"
import type { OrgUnit } from "./org-unit"

export interface RoleProps {
  readonly name: string
}

/**
 * Represents a role within an organizational unit.
 *
 * Roles are scoped to specific organizational units and define
 * who (human or system) can execute steps in a process.
 *
 * @example
 * ```typescript
 * const finance = new OrgUnit(org, "finance", {
 *   name: "Finance Department",
 *   type: "department"
 * })
 *
 * const accountant = new Role(finance, "accountant", {
 *   name: "Accountant"
 * })
 * ```
 */
export class Role extends Construct {
  readonly isRole: true = true
  readonly name: string
  readonly orgUnit: OrgUnit

  constructor(scope: OrgUnit, id: string, props?: RoleProps) {
    super(scope, id)
    this.name = props ? props.name : id
    this.orgUnit = scope
  }
}
