import { DateTime, Schema as ES } from "effect"
import { Form, type OrgUnit, Phase, Process, Role, Schedule } from "@pf/process"

export class OnBoarding extends Process {
  constructor(scope: OrgUnit, id: string, it: Role, facilities: Role) {
    const hr = new Role(scope, "HR", { name: "HR" })
    const hiring_manager = new Role(scope, "Hiring manager", {
      name: "Hiring Manager",
    })
    // TODO: how to model the person we are going to create?
    const new_employee = new Role(scope, "New employee", {
      name: "New Employee",
    })

    super(scope, id, {
      name: "Onboard a new employee",
      purpose:
        "Efficiently and effectively integrate a new employee into the organization, ensuring they have the necessary tools, knowledge, and access to become productive quickly, while ensuring all legal and administrative requirements are met.",
      responsibilities: [
        {
          role: hr,
          responsibility: "Human Resources tasks",
        },
        {
          role: it,
          responsibility: "Technical provisioning",
        },
        {
          role: new_employee,
          responsibility: "Employee actions",
        },
        {
          role: facilities,
          responsibility: "Workspace logistics",
        },
        {
          role: hiring_manager,
          responsibility: "Team oversight",
        },
      ],
    })

    const preBoarding = new Phase(scope, "preboarding", {
      name: "Pre-boarding",
    })
    const day1 = new Phase(scope, "day1", {
      name: "Day 1",
    })
    const week1 = new Phase(scope, "week1", {
      name: "Week 1",
    })
    const day30 = new Phase(scope, "day30", {
      name: "Day 30",
    })
    const day90 = new Phase(scope, "day90", {
      name: "Day 90",
    })

    // Tasks

    // Pre-boarding
    const send_welcome_pack = new Form(this, "Send welcome pack", {
      name: "Send welcome packet",
      purpose: "Timeline, policies, onboarding portal access",
      form: () => ({
        first_name: ES.String,
        last_name: ES.String,
        start_date: ES.DateTimeUtc,
      }),
      role: hr,
      phase: preBoarding,
    })

    // TODO: The background check has cleared before the start date.
    const background_check = new Form(this, "Background check", {
      name: "Initiate a background check",
      purpose: "Identity + employment verification",
      form: () => ({}),
      role: hr,
      phase: preBoarding,
    })

    const create_account = new Form(this, "Create account", {
      name: "create accounts (email, system access)",
      form: () => ({}),
      role: it,
      phase: preBoarding,
    })

    const provision_laptop = new Form(this, "Provision laptop", {
      purpose: "Image device and install apps",
      form: () => ({}),
      role: it,
      phase: preBoarding,
    })

    const assign_desk = new Form(this, "Assign desk", {
      name: "Assign a desk/office",
      form: () => ({}),
      role: facilities,
      phase: day1,
    })

    const provision_badge = new Form(this, "Assign ID badge", {
      form: () => ({}),
      role: facilities,
      phase: day1,
    })

    const prepare_onboarding = new Form(this, "Onboarding checklist", {
      name: "Receives a notification with an on-boarding checklist (e.g., prepare a 30-60-90 day plan, assign a buddy)",
      form: () => ({}),
      role: hiring_manager,
      phase: preBoarding,
    })

    // Day 1

    const orientation_session = new Form(this, "Orientation session", {
      purpose:
        "HR conducts an orientation session covering company culture, policies, and benefits",
      form: () => ({}),
      role: hiring_manager,
      phase: day1,
    })

    const provide_laptop = new Form(this, "Provide laptop and badge", {
      name: "Provide laptop",
      purpose: "Provide employee with hardware and login credentials",
      form: () => ({}),
      role: it,
      phase: day1,
    })

    const plan_review = new Form(this, "Review 30-60-90 day plan", {
      purpose:
        "Hiring Manager welcomes the employee, introduces them to the team, and reviews the 30-60-90 day plan",
      form: () => ({}),
      role: hiring_manager,
      phase: day1,
    })

    // Week 1

    const compliance_training = new Form(this, "Compliance training", {
      purpose:
        "The employee completes mandatory compliance training (e.g., security awareness, code of conduct)",
      form: () => ({}),
      role: new_employee,
      phase: week1,
    })

    // The Hiring Manager schedules regular check-in meetings

    // The employee meets with key team members and stakeholders

    // Day 30 Check-in

    const day_30_check_in = new Form(this, "Day 30 check-in", {
      purpose:
        "Meet with the employee to discuss their experience, answer questions, and provide feedback",
      form: () => ({}),
      role: hiring_manager,
      phase: day30,
    })

    // **Day 90 Check-in (End of Probation)**: A formal performance review is conducted by the Hiring Manager

    const formal_performance_review = new Form(
      this,
      "Formal performance review",
      {
        purpose:
          "A formal performance review is conducted by the Hiring Manager",
        role: hiring_manager,
        phase: day90,
        form: () => ({
          passed: ES.Boolean,
        }),
      },
    )

    const permanent = new Form(this, "Passed", {
      purpose: "The employee's status is changed to permanent.",
      form: () => ({}),
      role: hiring_manager,
      phase: day90,
    })

    const improvement_or_off_boarding = new Form(this, "Probation failed", {
      purpose: "A formal performance review is conducted by the Hiring Manager",
      role: hiring_manager,
      phase: day90,
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
    flow1.end(background_check)

    // Schedule-based transitions: when a transition should trigger
    // based on state-derived DateTime values
    flow1
      .next(create_account, {
        schedule: {
          fn: (state) => state.start_date,
          text: "On the employee start date",
        },
      })
      .next(provision_laptop)
      .end(provide_laptop)

    flow1.end(assign_desk, {
      schedule: {
        fn: (state) =>
          // 1 week before start date
          Schedule.fromPoint(state.start_date, { days: -7 }),
        text: "One week before start",
      },
    })

    flow1.end(provision_badge, {
      schedule: {
        fn: (state) =>
          // 1 week before start date
          Schedule.fromPoint(state.start_date, { days: -7 }),
        text: "One week before start",
      },
    })

    flow1.end(prepare_onboarding, {
      schedule: {
        fn: (state) =>
          // 1 week before start date
          Schedule.fromPoint(state.start_date, { days: -7 }),
        text: "One week before start",
      },
    })

    flow1.next(orientation_session, {
      schedule: {
        fn: (state) => state.start_date,
        text: "On employee start date",
      },
    })

    const flow2 = flow1.next(plan_review, {
      schedule: {
        fn: (state) => state.start_date,
        text: "On employee start date",
      },
    })

    // Note: schedule transitions don't need else branches - they determine WHEN
    // to trigger, not IF to trigger. All scheduled flows will eventually execute.

    // TODO: complete within 1 week
    orientation_session.end(compliance_training)

    flow2
      .next(day_30_check_in, {
        schedule: {
          fn: (state) =>
            // 30 days after start date
            DateTime.add(state.start_date, { days: 30 }),
          text: "30 days after start date",
        },
      })
      .end()

    // TODO add support for boolean logic in condition
    const flow_performance_review = day_30_check_in.next(
      formal_performance_review,
    )

    flow_performance_review.end(permanent, {
      condition: { fn: (state) => state.passed, text: "passed" },
    })

    // Else branch for formal_performance_review: if not passed, start improvement or off-boarding
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
