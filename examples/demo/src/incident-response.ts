import { Form, type OrgUnit, Process, type Role } from "@pf/process"
import {
  coordinateResponseForm,
  reportIncidentForm,
} from "./incident-response-forms"

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

    const report_incident = new Form(this, "Report incident", {
      name: "Report incident details",
      form: reportIncidentForm,
      browser: {
        entrypoint: "src/incident-response-forms.ts",
        exportName: "reportIncidentForm",
      },
      role: employeeRole,
    })

    const coordinate_response = new Form(this, "Coordinate response", {
      name: "Coordinate incident response",
      form: coordinateResponseForm,
      browser: {
        entrypoint: "src/incident-response-forms.ts",
        exportName: "coordinateResponseForm",
      },
      role: managerRole,
    })

    this.start(report_incident).end(coordinate_response)
  }
}
