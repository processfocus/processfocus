import { Schema as ES } from "effect"
import { FormLabel } from "@pf/form-schema"
import { Form, type OrgUnit, Process, type Role } from "@pf/process"

export class BugReportFix extends Process {
  constructor(
    scope: OrgUnit,
    id: string,
    employeeRole: Role,
    managerRole: Role,
  ) {
    super(scope, id, {
      name: "Bug Report and Fix",
      purpose: "Report and track bug resolution",
    })

    // Steps
    const report_bug = new Form(this, "Report bug", {
      name: "Report bug details",
      form: () => ({
        short_description: ES.String.annotations({ [FormLabel]: "Summary" }),
        full_description: ES.String.annotations({ [FormLabel]: "Description" }),
        urgency: ES.String,
      }),
      role: employeeRole,
    })

    const review_bug = new Form(this, "Review bug", {
      name: "Review and assign bug",
      form: () => ({}),
      role: managerRole,
    })

    // Flow
    this.start(report_bug).end(review_bug)
  }
}
