import { Construct } from "constructs"
import type { OrgUnit } from "./org-unit"

export interface PhaseProps {
  readonly name: string
}

/**
 * Represents a phase in a process. Steps can be assigned a phase, and
 * will be visually indicates as being part of the given phase in a
 * swimlane.
 *
 */
export class Phase extends Construct {
  readonly name: string
  readonly orgUnit: OrgUnit

  constructor(scope: OrgUnit, id: string, props?: PhaseProps) {
    super(scope, id)
    this.name = props ? props.name : id
    this.orgUnit = scope
  }
}
