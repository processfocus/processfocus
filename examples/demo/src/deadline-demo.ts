import { Duration, Effect, Schema } from "effect"
import { Form, NodeStep, type OrgUnit, Process, type Role } from "@pf/process"
import {
  deadlineCompleteForm,
  deadlineManagerForm,
  deadlineStartForm,
} from "./deadline-demo-forms"

/** Illustrative staged approval, without sending external notifications. */
export class DeadlineDemo extends Process {
  constructor(
    scope: OrgUnit,
    id: string,
    role: Role,
    managerRole: Role,
    interrupting = false,
  ) {
    super(scope, id, {
      name: interrupting ? "Interrupting Deadline Demo" : "Task Deadline Demo",
      purpose: interrupting
        ? "After 60 seconds, an unanswered approval is retired and redirected to manager review."
        : "An approval receives a reminder after 30 seconds and manager work after 60 seconds. Completing it leaves triggered work open.",
    })
    const start = new Form(this, "Start", {
      role,
      form: deadlineStartForm,
      browser: {
        entrypoint: "src/deadline-demo-forms.ts",
        exportName: "deadlineStartForm",
      },
    })
    const started = this.start(start)
    const acknowledge = new Form(started, "Acknowledge", {
      name: "Approve request",
      role,
      form: deadlineCompleteForm,
      browser: {
        entrypoint: "src/deadline-demo-forms.ts",
        exportName: "deadlineCompleteForm",
      },
    })
    const reminder = new NodeStep(started, "Reminder", {
      name: "Record reminder",
      input: (state) => Effect.succeed({ subject: state.subject }),
      output: { reminderRecorded: Schema.Boolean },
      execute: ({ subject }) =>
        Effect.gen(function* () {
          yield* Effect.log("Deadline reminder", { subject })
          return { reminderRecorded: true }
        }),
    })
    started.next(acknowledge).end()
    acknowledge
      .onDeadline("reminder", {
        after: Duration.seconds(30),
        handler: reminder,
      })
      .end()
    const manager = new Form(started, "Manager", {
      name: "Manager review",
      role: managerRole,
      form: deadlineManagerForm,
      browser: {
        entrypoint: "src/deadline-demo-forms.ts",
        exportName: "deadlineManagerForm",
      },
    })
    acknowledge
      .onDeadline("escalation", {
        after: Duration.seconds(60),
        interrupting,
        handler: manager,
      })
      .end()
    const managerReminder = new NodeStep(started, "ManagerReminder", {
      name: "Record manager reminder",
      input: (state) => Effect.succeed({ subject: state.subject }),
      output: { managerReminderRecorded: Schema.Boolean },
      execute: ({ subject }) =>
        Effect.log("Manager deadline reminder", { subject }).pipe(
          Effect.as({ managerReminderRecorded: true }),
        ),
    })
    manager
      .onDeadline("reminder", {
        after: Duration.seconds(30),
        handler: managerReminder,
      })
      .end()
  }
}
