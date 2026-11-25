import { Form, type OrgUnit, Process, type Role } from "@pf/process"
import { approveVendorForm, submitVendorForm } from "./vendor-onboarding-forms"

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

    const submit_vendor = new Form(this, "Submit vendor", {
      name: "Submit vendor information",
      form: submitVendorForm,
      browser: {
        entrypoint: "src/vendor-onboarding-forms.ts",
        exportName: "submitVendorForm",
      },
      role: employeeRole,
    })

    const approve_vendor = new Form(this, "Approve vendor", {
      name: "Approve vendor onboarding",
      form: approveVendorForm,
      browser: {
        entrypoint: "src/vendor-onboarding-forms.ts",
        exportName: "approveVendorForm",
      },
      role: managerRole,
    })

    this.start(submit_vendor).end(approve_vendor)
  }
}
