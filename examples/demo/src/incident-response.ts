import { Schema as ES } from "effect"
import { Form, type OrgUnit, Process, type Role } from "@pf/process"

export class IncidentResponse extends Process {
  constructor(
    scope: OrgUnit,
    id: string,
    employeeRole: Role,
    managerRole: Role,
  ) {
    super(scope, id, {
      name: "Incident Response",
      purpose: "Coordinate cross team incident resolution",
    })

    // Steps
    const report_incident = new Form(this, "Report incident", {
      name: "Report incident details",
      form: () => ({
        incident: ES.String,
      }),
      role: employeeRole,
    })

    const coordinate_response = new Form(this, "Coordinate response", {
      name: "Coordinate incident response",
      form: () => ({}),
      role: managerRole,
    })

    // Flow
    this.start(report_incident).end(coordinate_response)
  }
}
