import { DateTime, Schema as ES, Effect } from "effect"
import { Form } from "./form"
import { NodeStep } from "./node_step"
import { OrgUnit } from "./org-unit"
import { Organisation } from "./organisation"
import { Process } from "./process"
import { Role } from "./role"
import { beforeEach, describe, expect, it } from "bun:test"

describe("Step - Type-safe state accumulation", () => {
  let organisation: Organisation
  let orgUnit: OrgUnit
  let mockRole: Role

  beforeEach(() => {
    organisation = new Organisation({ name: "Test Organisation" })
    orgUnit = new OrgUnit(organisation, "test-unit", {
      name: "Test Unit",
      type: "department",
    })
    mockRole = new Role(orgUnit, "mock", { name: "Mock Role" })
  })

  it("should infer state from a single step with output", () => {
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({
        name: ES.String,
        age: ES.Number,
      }),
    })

    const flow = process.start(step1)

    // Type test: flow should have state { name: string, age: number }
    // This is verified at compile time - no runtime check needed
    expect(flow).toBeDefined()
  })

  it("should accumulate state through chaining", () => {
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({
        first_name: ES.String,
        last_name: ES.String,
      }),
    })

    const step2 = new Form(process, "step2", {
      role: mockRole,
      form: () => ({
        email: ES.String,
      }),
    })

    const step3 = new Form(process, "step3", {
      role: mockRole,
      form: () => ({
        age: ES.Number,
      }),
    })

    const flow = process
      .start(step1)
      .next(step2, {
        condition: {
          fn: (state) => {
            // At this point, state should have: { first_name, last_name }
            const nameLength = state.first_name.length
            const lastNameLength = state.last_name.length

            // This should NOT be available yet (uncomment to see type error):
            // const emailLength = state.email.length

            return nameLength > 0 && lastNameLength > 0
          },
        },
      })
      .next(step3, {
        condition: {
          fn: (state) => {
            // At this point, state should have: { first_name, last_name, email }
            const nameLength = state.first_name.length
            const emailLength = state.email.length

            // This should NOT be available yet (uncomment to see type error):
            // const ageDouble = state.age * 2

            return nameLength > 0 && emailLength > 0
          },
        },
      })

    // After all chaining, flow should have accumulated all state
    const finalStep = new Form(process, "final", {
      role: mockRole,
      form: () => ({}),
    })
    flow.next(finalStep, {
      condition: {
        fn: (state) => {
          // state should have: { first_name, last_name, email, age }
          expect(state.first_name).toBeDefined()
          expect(state.last_name).toBeDefined()
          expect(state.email).toBeDefined()
          expect(state.age).toBeDefined()

          return true
        },
      },
    })

    expect(flow).toBeDefined()
  })

  it("should match the onboarding example pattern", () => {
    const process = new Process(orgUnit, "onboarding", {
      name: "Onboarding",
      purpose: "Test",
    })

    // Simulate the onboarding flow structure
    const send_welcome_pack = new Form(process, "send_welcome_pack", {
      role: mockRole,
      form: () => ({
        first_name: ES.String,
        last_name: ES.String,
        start_date: ES.DateTimeUtc,
      }),
    })

    const plan_review = new Form(process, "plan_review", {
      role: mockRole,
      form: () => ({}),
    })

    const day_30_check_in = new Form(process, "day_30_check_in", {
      role: mockRole,
      form: () => ({}),
    })

    const formal_performance_review = new Form(
      process,
      "formal_performance_review",
      {
        role: mockRole,
        form: () => ({
          passed: ES.Boolean,
        }),
      },
    )

    const permanent = new Form(process, "permanent", {
      role: mockRole,
      form: () => ({}),
    })

    // Chain the steps like in the onboarding example
    // CORRECT pattern: chain everything in one expression
    process
      .start(send_welcome_pack)
      .next(plan_review, {
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
      .next(day_30_check_in, {
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
      .next(formal_performance_review, {
        condition: {
          fn: (state) => {
            // At this point, state should have accumulated:
            // { first_name, last_name, start_date } from send_welcome_pack
            // (plan_review and day_30_check_in have no input, so they don't add anything)

            // These should all be available:
            expect(state.first_name).toBeDefined()
            expect(state.last_name).toBeDefined()
            expect(state.start_date).toBeDefined()

            // This should NOT be available yet:
            // state.passed

            return DateTime.toEpochMillis(state.start_date) > 0
          },
        },
      })
      .end(permanent, {
        condition: {
          fn: (state) => {
            // At this point, state should have:
            // { first_name, last_name, start_date, passed }

            // All of these should be available:
            expect(state.first_name).toBeDefined()
            expect(state.last_name).toBeDefined()
            expect(state.start_date).toBeDefined()
            expect(typeof state.passed).toBe("boolean")

            return state.passed
          },
        },
      })

    expect(true).toBe(true)
  })

  it("should handle steps without input", () => {
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({
        name: ES.String,
      }),
    })

    const step2 = new Form(process, "step2", {
      role: mockRole,
      form: () => ({}),
    })

    const step3 = new Form(process, "step3", {
      role: mockRole,
      form: () => ({
        age: ES.Number,
      }),
    })

    const finalStep = new Form(process, "final", {
      role: mockRole,
      form: () => ({}),
    })

    process
      .start(step1)
      .next(step2)
      .next(step3, {
        condition: {
          fn: (state) => {
            // State should have { name } from step1, nothing from step2
            expect(state.name).toBeDefined()

            // age should NOT be available yet
            // state.age

            return true
          },
        },
      })
      .next(finalStep, {
        condition: {
          fn: (state) => {
            // State should have { name, age }
            expect(state.name).toBeDefined()
            expect(state.age).toBeDefined()

            return true
          },
        },
      })

    expect(true).toBe(true)
  })

  it("should support natural step definition pattern with flow variables", () => {
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    // Use Form for user-facing steps (requires role)
    const step1 = new Form(process, "Step1", {
      role: mockRole,
      form: () => ({ name: ES.String }),
    })

    // Start returns a typed flow
    const flow1 = process.start(step1)

    // Create step2 using flow1 as scope - NodeStep is now a SystemStep
    const step2 = new NodeStep(flow1, "Step2", {
      input: (state) => Effect.succeed({ name: state.name }),
      output: { age: ES.Number },
      execute: (input) => {
        // input is the derived input { name: string }
        expect(input.name).toBeDefined()
        return Effect.succeed({ age: 25 })
      },
    })

    // Connect step2 to get flow with accumulated state
    const flow2 = flow1.next(step2, {
      condition: {
        fn: (state) => {
          expect(state.name).toBeDefined()
          // age is NOT available yet - we're deciding whether to transition TO step2
          return state.name.length > 0
        },
      },
    })

    // Create step3 using flow2 as scope - another SystemStep
    const step3 = new NodeStep(flow2, "Step3", {
      input: (state) =>
        Effect.succeed({ name: state.name, age: state["age"] as number }),
      output: { email: ES.String },
      execute: (input) => {
        // input is the derived input { name: string, age: number }
        expect(input.name).toBeDefined()
        expect(input.age).toBeDefined()
        return Effect.succeed({ email: "test@example.com" })
      },
    })

    flow2.next(step3, {
      condition: {
        fn: (state) => {
          expect(state.name).toBeDefined() // From step1's accumulated state
          expect(state["age"]).toBeDefined() // From step2's output
          // email is NOT available yet - we're deciding whether to transition TO step3

          return true
        },
      },
    })

    expect(true).toBe(true)
  })

  it("should expose onError only on system steps", () => {
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const formStep = new Form(process, "form_step", {
      role: mockRole,
      form: () => ({}),
    })
    const systemStep = new NodeStep(process, "system_step", {
      input: () => Effect.succeed({}),
      output: {},
      execute: () => Effect.succeed({}),
    })

    const systemHasOnError: "onError" extends keyof typeof systemStep
      ? true
      : false = true
    const formHasOnError: "onError" extends keyof typeof formStep
      ? true
      : false = false

    expect(systemHasOnError).toBe(true)
    expect(formHasOnError).toBe(false)
  })
})
