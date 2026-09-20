import { DateTime, Schema as ES } from "effect"
import { Form, type OrgUnit, Process, Role } from "@pf/process"

export class OnBoarding extends Process {
  constructor(scope: OrgUnit, id: string) {
    super(scope, id, {
      name: "Onboard a new employee",
      purpose:
        "Efficiently and effectively integrate a new employee into the organization, ensuring they have the necessary tools, knowledge, and access to become productive quickly, while ensuring all legal and administrative requirements are met.",
    })

    const hr = new Role(scope, "HR", { name: "HR" })
    const it = new Role(scope, "IT", { name: "IT" })
    const hiring_manager = new Role(scope, "Hiring manager", {
      name: "Hiring Manager",
    })
    const facilities = new Role(scope, "Facilities", { name: "Facilities" })
    // TODO: how to model the person we are going to create?
    const new_employee = new Role(scope, "New employee", {
      name: "New Employee",
    })

    // Tasks

    // Pre-boarding
    const send_welcome_pack = new Form(this, "Send welcome pack", {
      name: "Send a welcome packet and necessary forms",
      form: () => ({
        first_name: ES.String,
        last_name: ES.String,
        start_date: ES.DateTimeUtc,
      }),
      role: hr,
    })

    // TODO: The background check has cleared before the start date.
    const background_check = new Form(this, "Background check", {
      name: "Initiate a background check",
      form: () => ({}),
      role: hr,
    })

    const create_account = new Form(this, "Create account", {
      name: "create accounts (email, system access)",
      form: () => ({}),
      role: it,
    })

    const provision_laptop = new Form(this, "Provision laptop", {
      form: () => ({}),
      role: it,
    })

    const assign_desk = new Form(this, "Assign desk", {
      name: "Assign a desk/office",
      form: () => ({}),
      role: facilities,
    })

    const provision_badge = new Form(this, "Assign ID badge", {
      form: () => ({}),
      role: facilities,
    })

    const prepare_onboarding = new Form(this, "Onboarding checklist", {
      name: "Receives a notification with an on-boarding checklist (e.g., prepare a 30-60-90 day plan, assign a buddy)",
      form: () => ({}),
      role: hiring_manager,
    })

    // Day 1

    const orientation_session = new Form(this, "Orientation session", {
      purpose:
        "HR conducts an orientation session covering company culture, policies, and benefits",
      form: () => ({}),
      role: hiring_manager,
    })

    const provide_laptop = new Form(this, "Provide laptop and badge", {
      name: "Provide employee with hardware and login credentials",
      form: () => ({}),
      role: it,
    })

    const plan_review = new Form(this, "Review 30-60-90 day plan", {
      purpose:
        "Hiring Manager welcomes the employee, introduces them to the team, and reviews the 30-60-90 day plan",
      form: () => ({}),
      role: hiring_manager,
    })

    // Week 1

    const compliance_training = new Form(this, "Compliance training", {
      purpose:
        "The employee completes mandatory compliance training (e.g., security awareness, code of conduct)",
      form: () => ({}),
      role: new_employee,
    })

    // The Hiring Manager schedules regular check-in meetings

    // The employee meets with key team members and stakeholders

    // Day 30 Check-in

    const day_30_check_in = new Form(this, "Meet with employee", {
      purpose:
        "Meet with the employee to discuss their experience, answer questions, and provide feedback",
      form: () => ({}),
      role: hiring_manager,
    })

    // **Day 90 Check-in (End of Probation)**: A formal performance review is conducted by the Hiring Manager

    const formal_performance_review = new Form(
      this,
      "Formal performance review",
      {
        purpose:
          "A formal performance review is conducted by the Hiring Manager",
        role: hiring_manager,
        form: () => ({
          passed: ES.Boolean,
        }),
      },
    )

    const permanent = new Form(this, "Passed", {
      purpose: "The employee's status is changed to permanent.",
      form: () => ({}),
      role: hiring_manager,
    })

    const improvement_or_off_boarding = new Form(this, "Probation failed", {
      purpose: "A formal performance review is conducted by the Hiring Manager",
      role: hiring_manager,
      form: () => ({
        // TODO: needs to become one selection, starts separate process
        start_offboarding: ES.Boolean,
        start_improvement_process: ES.Boolean,
      }),
    })

    // **Close Onboarding Process**: HR confirms all checklist items are complete and closes the onboarding record.

    // Step/check or do we rely on interventions?
    // Perhaps we need to track a checklist, and here we check this is completed.
    // Or checklist is simply todos
    // Could show list of these todos here, and don't allow to mark as done if one of them is still open.
    // We need: security awareness, code of conduct complete, but should already have been done by end of week 1

    // Flow

    // State builds automatically as steps are chained
    const flow1 = this.start(send_welcome_pack)
    // Unconditional flow - background check always happens
    flow1.end(background_check)

    // TODO: need to setup logic to use start date in expressions
    // TODO: need logic for date expressions
    // TODO: need ability to preview/see upcoming todos (and even schedule them)
    flow1
      .next(create_account, {
        condition: {
          fn: (state) => {
            // Now state is properly typed as: { first_name: string, last_name: string, start_date: DateTime.Utc }
            return DateTime.toEpochMillis(state.start_date) > 0
          },
        },
      })
      .end(provision_laptop)

    flow1.end(assign_desk, {
      condition: {
        fn: (state) => {
          // 1 week before start date
          const oneWeekBeforeStart = DateTime.subtract(state.start_date, {
            days: 7,
          })
          return DateTime.greaterThanOrEqualTo(
            DateTime.unsafeNow(),
            oneWeekBeforeStart,
          )
        },
      },
    })

    flow1.end(provision_badge, {
      condition: {
        fn: (state) => {
          // 1 week before start date
          const oneWeekBeforeStart = DateTime.subtract(state.start_date, {
            days: 7,
          })
          return DateTime.greaterThanOrEqualTo(
            DateTime.unsafeNow(),
            oneWeekBeforeStart,
          )
        },
      },
    })

    flow1.end(prepare_onboarding, {
      condition: {
        fn: (state) => {
          // 1 week before start date
          const oneWeekBeforeStart = DateTime.subtract(state.start_date, {
            days: 7,
          })
          return DateTime.greaterThanOrEqualTo(
            DateTime.unsafeNow(),
            oneWeekBeforeStart,
          )
        },
      },
    })

    flow1.next(orientation_session, {
      condition: {
        fn: (state) => {
          // On start date
          return DateTime.greaterThanOrEqualTo(
            DateTime.unsafeNow(),
            state.start_date,
          )
        },
      },
    })

    flow1.end(provide_laptop, {
      condition: {
        fn: (state) => {
          // On start date
          return DateTime.greaterThanOrEqualTo(
            DateTime.unsafeNow(),
            state.start_date,
          )
        },
      },
    })

    const flow2 = flow1.next(plan_review, {
      condition: {
        fn: (state) => {
          // On start date
          return DateTime.greaterThanOrEqualTo(
            DateTime.unsafeNow(),
            state.start_date,
          )
        },
      },
    })

    // Else branch: if none of the date conditions are met yet, wait (no action)
    flow1.elseEnd()

    // TODO: complete within 1 week
    orientation_session.end(compliance_training)

    flow2.next(day_30_check_in, {
      condition: {
        fn: (state) => {
          // 30 days after start date
          const thirtyDaysAfterStart = DateTime.add(state.start_date, {
            days: 30,
          })
          return DateTime.greaterThanOrEqualTo(
            DateTime.unsafeNow(),
            thirtyDaysAfterStart,
          )
        },
      },
    })
    // Else branch for plan_review: wait if 30 days haven't passed yet
    flow2.elseEnd()

    // TODO add support for boolean logic in condition
    const flow_performance_review = day_30_check_in.next(
      formal_performance_review,
    )

    flow_performance_review.end(permanent, {
      condition: { fn: (state) => state.passed },
    })

    flow_performance_review.else().end(improvement_or_off_boarding)

    // Controls & Compliance
    // **I-9/Employment Eligibility Verification**: Must be completed within
    // the first three days of employment (in the US).
    // TODO: add task for this
    // If fails, start off-boarding process

    // KPIs & SLAs: see very good list
    /*
     * **New Hire Satisfaction Score**: \>85% satisfaction on the onboarding experience survey.
     * **Time to Productivity**: Time until the new hire is operating at a target performance level.18
     */

    // Edge case:
    // Background Check Fails**: The offer is rescinded, and a notification is sent to all internal departments to cancel their pending tasks.

    // **State**: The employee's onboarding status could be OfferAccepted \-\> PreBoarding \-\> Active \-\> ProbationCompleted.
  }
}
