import { Schema as ES } from "effect"
import { BooleanField } from "@pf/form-schema"
import {
  Form,
  type OrgUnit,
  Process,
  type Role,
  Schedule,
  Sla,
} from "@pf/process"

export class TimeOffRequest extends Process {
  constructor(
    scope: OrgUnit,
    id: string,
    employeeRole: Role,
    managerRole: Role,
  ) {
    super(scope, id, {
      name: "Time Off Request",
      purpose: "Request vacation, sick leave, or personal time",
      sla: Sla.minutes(5),
    })

    // Steps
    const submit_request = new Form(this, "Submit time off request", {
      name: "Submit time off request",
      form: () => ({
        dates: ES.String,
      }),
      role: employeeRole,
    })

    // Start the flow to capture accumulated state
    const flow = this.start(submit_request)

    // new Form with flow scope infers state type automatically
    // Using form: for fields that accumulate into state
    const approve_request = new Form(flow, "Approve time off", {
      name: "Approve time off request",
      form: () => ({
        approved: BooleanField({ label: "I approve", required: true }),
      }),
      summary: (state, ctx) => ({
        When: state.dates,
        Requester: ctx.step.submitTimeOffRequest.providerUser.name,
      }),
      role: managerRole,
      sla: Sla.minutes(1),
    })

    // Chain to next step
    // Use Schedule.businessMinutes() for business-calendar-aware scheduling
    // Falls back to clock time when no calendar is configured
    const flow2 = flow.next(approve_request, {
      schedule: {
        fn: (_state, ctx) => {
          const completedAt = ctx.step.submitTimeOffRequest.completedAt
          // Skip delay only if E2E_SKIP_DELAYS is explicitly "true"
          if (process.env["E2E_SKIP_DELAYS"] === "true") {
            return completedAt
          }
          // Use business minutes scheduling - respects business calendar
          // Example: if submitted at 4:30pm with 2 business minutes delay,
          // and business closes at 5pm, it appears at 9:02am next day
          return Schedule.businessMinutes(completedAt, 2)
        },
        text: "2 business minutes from submission",
      },
    })

    // Third step - should have access to both previous steps
    const notify_employee = new Form(flow2, "Notify employee", {
      name: "Notify employee of decision",
      form: () => ({}),
      summary: (state, ctx) => ({
        Dates: state.dates,
        Decision: state.approved ? "Approved" : "Denied",
        // Can access both previous steps - providerUser is required since these are Form steps
        Requester: ctx.step.submitTimeOffRequest.providerUser.name,
        Approver: ctx.step.approveTimeOff.providerUser.name,
      }),
      role: managerRole,
    })

    // Flow
    flow2.end(notify_employee)
  }
}
