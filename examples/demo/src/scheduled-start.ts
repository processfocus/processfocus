import { DateTime } from "effect"
import { Form, type OrgUnit, Process, type Role } from "@pf/process"
import {
  immediateForm,
  scheduledForm,
  startForm,
} from "./scheduled-start-forms"

/** No-input counterpart to onboarding for schedule-mode acceptance. */
export class ScheduledStart extends Process {
  constructor(scope: OrgUnit, id: string, role: Role) {
    super(scope, id, {
      name: "Scheduled follow-up",
      purpose: "Start without form data and release a scheduled follow-up",
    })
    const start = new Form(this, "Start", {
      role,
      form: startForm,
      browser: {
        entrypoint: "src/scheduled-start-forms.ts",
        exportName: "startForm",
      },
    })
    const immediate = new Form(this, "Immediate", {
      role,
      form: immediateForm,
      browser: {
        entrypoint: "src/scheduled-start-forms.ts",
        exportName: "immediateForm",
      },
    })
    const scheduled = new Form(this, "Scheduled", {
      role,
      form: scheduledForm,
      browser: {
        entrypoint: "src/scheduled-start-forms.ts",
        exportName: "scheduledForm",
      },
    })
    const flow = this.start(start)
    flow.end(immediate)
    flow.end(scheduled, {
      schedule: {
        fn: () => DateTime.makeUnsafe("2099-01-01T00:00:00Z"),
        text: "On 1 January 2099",
      },
    })
  }
}
