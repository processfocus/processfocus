import { Schema as ES } from "effect"
import { Form, type OrgUnit, Process, type Role } from "@pf/process"

export class VendorOnboarding extends Process {
  constructor(
    scope: OrgUnit,
    id: string,
    employeeRole: Role,
    managerRole: Role,
  ) {
    super(scope, id, {
      name: "Vendor Onboarding",
      purpose: "Collect documents and approvals for new vendors",
    })

    // Steps
    const submit_vendor = new Form(this, "Submit vendor", {
      name: "Submit vendor information",
      form: () => ({
        vendor_name: ES.String,
      }),
      role: employeeRole,
    })

    const approve_vendor = new Form(this, "Approve vendor", {
      name: "Approve vendor onboarding",
      form: () => ({}),
      role: managerRole,
    })

    // Flow
    this.start(submit_vendor).end(approve_vendor)
  }
}
