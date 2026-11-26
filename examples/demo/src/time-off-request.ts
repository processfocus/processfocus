import { Effect } from "effect"
import {
  Form,
  type OrgUnit,
  Process,
  type Role,
  Schedule,
  Sla,
} from "@pf/process"
import { demoConfiguration } from "./configuration"
import {
  approveTimeOffForm,
  notifyEmployeeForm,
  submitTimeOffRequestForm,
} from "./time-off-request-forms"

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

    const submit_request = new Form(this, "Submit time off request", {
      name: "Submit time off request",
      form: submitTimeOffRequestForm,
      browser: {
        entrypoint: "src/time-off-request-forms.ts",
        exportName: "submitTimeOffRequestForm",
      },
      role: employeeRole,
    })

    // Start the flow to capture accumulated state
    const flow = this.start(submit_request)

    // new Form with flow scope infers state type automatically
    // Using form: for fields that accumulate into state
    const approve_request = new Form(flow, "Approve time off", {
      name: "Approve time off request",
      form: approveTimeOffForm,
      browser: {
        entrypoint: "src/time-off-request-forms.ts",
        exportName: "approveTimeOffForm",
      },
      summary: (state, ctx) => ({
        When: state.dates,
        Requester: ctx.step.submitTimeOffRequest.providerUser.name,
      }),
      role: managerRole,
      sla: Sla.minutes(1),
    })

    // Use Schedule.businessMinutes() for business-calendar-aware scheduling
    // Falls back to clock time when no calendar is configured
    const flow2 = flow.next(approve_request, {
      schedule: {
        fn: (_state, ctx) => {
          const completedAt = ctx.step.submitTimeOffRequest.completedAt
          // Read the same delay switch validated by deployment preflight.
          if (
            Effect.runSync(
              Effect.gen(function* () {
                return yield* demoConfiguration.fields.skipDelays.config
              }),
            )
          ) {
            return completedAt
          }
          // Use business minutes scheduling - respects business calendar
          return Schedule.businessMinutes(completedAt, 2)
        },
        text: "2 business minutes from submission",
      },
    })

    // Third step - should have access to both previous steps
    const notify_employee = new Form(flow2, "Notify employee", {
      name: "Notify employee of decision",
      form: notifyEmployeeForm,
      browser: {
        entrypoint: "src/time-off-request-forms.ts",
        exportName: "notifyEmployeeForm",
      },
      summary: (state, ctx) => ({
        Dates: state.dates,
        Decision: state.approved ? "Approved" : "Denied",
        // Can access both previous steps - providerUser is required since these are Form steps
        Requester: ctx.step.submitTimeOffRequest.providerUser.name,
        Approver: ctx.step.approveTimeOff.providerUser.name,
      }),
      role: managerRole,
    })

    flow2.end(notify_employee)
  }
}
