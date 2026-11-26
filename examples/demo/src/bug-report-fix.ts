import { Form, type OrgUnit, Process, type Role } from "@pf/process"
import { reportBugForm, reviewBugForm } from "./bug-report-fix-forms"

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

    const report_bug = new Form(this, "Report bug", {
      name: "Report bug details",
      form: reportBugForm,
      browser: {
        entrypoint: "src/bug-report-fix-forms.ts",
        exportName: "reportBugForm",
      },
      role: employeeRole,
    })

    const review_bug = new Form(this, "Review bug", {
      name: "Review and assign bug",
      form: reviewBugForm,
      browser: {
        entrypoint: "src/bug-report-fix-forms.ts",
        exportName: "reviewBugForm",
      },
      role: managerRole,
    })

    this.start(report_bug).end(review_bug)
  }
}
