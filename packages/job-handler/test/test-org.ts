import { Schema } from "effect"
import { Form, Organisation, Process, Role, Sla } from "@pf/process"

/**
 * Creates a minimal test organisation with a 2-step process.
 *
 * Process: Simple Process
 * - Step 1: Submit (has input)
 * - Step 2: Approve
 * - Flow: Submit -> Approve (no condition, always executes)
 */
export const createTestOrganisation = () => {
  const org = new Organisation({ name: "TestOrg" })
  const employee = new Role(org, "employee", { name: "Employee" })

  const process = new Process(org, "simple-process", {
    name: "Simple Process",
    purpose: "Test process for job worker",
  })

  const submit = new Form(process, "submit", {
    name: "Submit",
    role: employee,
    purpose: "Submit step",
    form: () => ({ data: Schema.String }),
  })

  const approve = new Form(process, "approve", {
    name: "Approve",
    role: employee,
    purpose: "Approve step",
    sla: Sla.minutes(5),
    form: () => ({}),
  })

  process.start(submit).next(approve)

  return { org, employee, process, submit, approve }
}
