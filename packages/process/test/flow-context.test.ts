import { DateTime } from "effect"
import {
  type CompletedStepData,
  buildFlowContext,
  getStepIdFromPath,
  toCamelCase,
} from "../src/lib/flow-context"
import { describe, expect, it } from "bun:test"

describe("toCamelCase", () => {
  it("converts space-separated words", () => {
    expect(toCamelCase("Submit time off request")).toBe("submitTimeOffRequest")
  })

  it("converts underscore-separated words", () => {
    expect(toCamelCase("approve_request")).toBe("approveRequest")
  })

  it("converts hyphen-separated words", () => {
    expect(toCamelCase("my-step")).toBe("myStep")
  })

  it("lowercases single word", () => {
    expect(toCamelCase("Submit")).toBe("submit")
  })

  it("handles already camelCase input", () => {
    expect(toCamelCase("alreadyCamel")).toBe("alreadycamel")
  })

  it("removes leading digits from first word", () => {
    // When first word is only digits, it's skipped and next word becomes first (lowercase)
    expect(toCamelCase("123 invalid start")).toBe("invalidStart")
    // When first word has digits followed by letters, just the digits are removed
    expect(toCamelCase("123abc def")).toBe("abcDef")
  })

  it("handles only digits in first word by prefixing with underscore", () => {
    expect(toCamelCase("123")).toBe("_")
  })

  it("removes non-alphanumeric characters", () => {
    expect(toCamelCase("Hello! World?")).toBe("helloWorld")
  })

  it("handles mixed separators", () => {
    expect(toCamelCase("my_mixed-case Example")).toBe("myMixedCaseExample")
  })

  it("returns 'unnamed' for empty string", () => {
    expect(toCamelCase("")).toBe("unnamed")
  })

  it("returns 'unnamed' for only separators", () => {
    expect(toCamelCase("   ---___")).toBe("unnamed")
  })

  it("handles uppercase words", () => {
    expect(toCamelCase("APPROVE REQUEST")).toBe("approveRequest")
  })

  it("handles multiple consecutive separators", () => {
    expect(toCamelCase("foo---bar___baz   qux")).toBe("fooBarBazQux")
  })
})

describe("getStepIdFromPath", () => {
  it("extracts step id from full path", () => {
    expect(
      getStepIdFromPath("hr/time-off-request/Submit time off request"),
    ).toBe("Submit time off request")
  })

  it("returns input if no slashes", () => {
    expect(getStepIdFromPath("Submit")).toBe("Submit")
  })

  it("handles trailing slash", () => {
    // Trailing slash is ignored - returns last non-empty segment
    expect(getStepIdFromPath("hr/time-off-request/")).toBe("time-off-request")
  })

  it("handles single segment with slash prefix", () => {
    expect(getStepIdFromPath("/Submit")).toBe("Submit")
  })
})

describe("buildFlowContext", () => {
  const baseDate = DateTime.unsafeFromDate(new Date("2025-01-01T10:00:00Z"))
  const processExecutionId = "pex-flow-context-123"

  function createCompletedStep(
    stepPath: string,
    completedAt: DateTime.DateTime,
    overrides: Partial<CompletedStepData> = {},
  ): CompletedStepData {
    return {
      stepPath,
      userId: "usr-123",
      userSub: "user@example.com",
      providerUserId: "emp-123",
      providerUserName: "John Doe",
      providerUserFirstName: "John",
      providerUserLastName: "Doe",
      providerUserEmail: "john@example.com",
      providerUserPicture: "https://example.com/john.jpg",
      completedAt,
      ...overrides,
    }
  }

  it("builds context with single completed step", () => {
    const steps: CompletedStepData[] = [
      createCompletedStep("hr/process/Submit request", baseDate),
    ]

    const context = buildFlowContext(processExecutionId, baseDate, steps)

    expect(context.process.executionId).toBe(processExecutionId)
    expect(context.process.startedAt).toEqual(baseDate)
    expect(context.step["submitRequest"]).toBeDefined()
    expect(context.step["submitRequest"]?.user.userId).toBe("usr-123")
    expect(context.step["submitRequest"]?.providerUser.name).toBe("John Doe")
    expect(context.step["submitRequest"]?.completedAt).toEqual(baseDate)
  })

  it("builds context with multiple completed steps", () => {
    const step1Time = DateTime.unsafeFromDate(new Date("2025-01-01T10:00:00Z"))
    const step2Time = DateTime.unsafeFromDate(new Date("2025-01-01T11:00:00Z"))
    const step3Time = DateTime.unsafeFromDate(new Date("2025-01-01T12:00:00Z"))

    const steps: CompletedStepData[] = [
      createCompletedStep("hr/process/Submit request", step1Time, {
        userId: "usr-1",
        providerUserName: "Alice",
      }),
      createCompletedStep("hr/process/Review request", step2Time, {
        userId: "usr-2",
        providerUserName: "Bob",
      }),
      createCompletedStep("hr/process/Approve request", step3Time, {
        userId: "usr-3",
        providerUserName: "Charlie",
      }),
    ]

    const context = buildFlowContext(processExecutionId, step1Time, steps)

    expect(context.process.executionId).toBe(processExecutionId)
    expect(Object.keys(context.step)).toHaveLength(3)
    expect(context.step["submitRequest"]?.providerUser.name).toBe("Alice")
    expect(context.step["reviewRequest"]?.providerUser.name).toBe("Bob")
    expect(context.step["approveRequest"]?.providerUser.name).toBe("Charlie")
  })

  it("sets startStep to the earliest completed step", () => {
    const step1Time = DateTime.unsafeFromDate(new Date("2025-01-01T11:00:00Z"))
    const step2Time = DateTime.unsafeFromDate(new Date("2025-01-01T10:00:00Z")) // Earlier
    const step3Time = DateTime.unsafeFromDate(new Date("2025-01-01T12:00:00Z"))

    // Pass steps in non-chronological order
    const steps: CompletedStepData[] = [
      createCompletedStep("hr/process/Step A", step1Time, {
        userId: "usr-1",
        providerUserName: "Alice",
      }),
      createCompletedStep("hr/process/Step B", step2Time, {
        userId: "usr-2",
        providerUserName: "Bob",
      }),
      createCompletedStep("hr/process/Step C", step3Time, {
        userId: "usr-3",
        providerUserName: "Charlie",
      }),
    ]

    const context = buildFlowContext(processExecutionId, step2Time, steps)

    expect(context.process.executionId).toBe(processExecutionId)
    // startStep should be the earliest (Step B completed by Bob)
    expect(context.process.startStep.providerUser.name).toBe("Bob")
    expect(context.process.startStep.completedAt).toEqual(step2Time)
  })

  it("handles empty completed steps array", () => {
    const context = buildFlowContext(processExecutionId, baseDate, [])

    expect(context.process.executionId).toBe(processExecutionId)
    expect(context.process.startedAt).toEqual(baseDate)
    expect(context.process.startStep.user.userId).toBe("")
    expect(context.process.startStep.providerUser.name).toBe("")
    expect(context.step).toEqual({})
  })

  it("converts step paths to camelCase keys", () => {
    const steps: CompletedStepData[] = [
      createCompletedStep("org/proc/Submit time off request", baseDate),
      createCompletedStep(
        "org/proc/manager-approval",
        DateTime.addDuration(baseDate, "1 second"),
      ),
    ]

    const context = buildFlowContext(processExecutionId, baseDate, steps)

    expect(context.process.executionId).toBe(processExecutionId)
    expect(context.step["submitTimeOffRequest"]).toBeDefined()
    expect(context.step["managerApproval"]).toBeDefined()
    // These shouldn't exist (original names)
    expect(context.step["Submit time off request"]).toBeUndefined()
    expect(context.step["manager-approval"]).toBeUndefined()
  })

  it("includes all provider user fields", () => {
    const steps: CompletedStepData[] = [
      createCompletedStep("org/proc/Submit", baseDate, {
        providerUserId: "emp-456",
        providerUserName: "Jane Smith",
        providerUserFirstName: "Jane",
        providerUserLastName: "Smith",
        providerUserEmail: "jane@example.com",
        providerUserPicture: "https://example.com/jane.jpg",
      }),
    ]

    const context = buildFlowContext(processExecutionId, baseDate, steps)

    expect(context.process.executionId).toBe(processExecutionId)
    const providerUser = context.step["submit"]!.providerUser
    expect(providerUser.id).toBe("emp-456")
    expect(providerUser.name).toBe("Jane Smith")
    expect(providerUser.firstName).toBe("Jane")
    expect(providerUser.lastName).toBe("Smith")
    expect(providerUser.email).toBe("jane@example.com")
    expect(providerUser.picture).toBe("https://example.com/jane.jpg")
  })

  it("handles M2M users with fallback provider user data", () => {
    const steps: CompletedStepData[] = [
      createCompletedStep("org/proc/Automated step", baseDate, {
        userId: "usr-system",
        userSub: "ci-pipeline",
        // M2M users get user.sub as fallback for provider user fields
        providerUserId: "",
        providerUserName: "ci-pipeline",
        providerUserFirstName: "ci-pipeline",
        providerUserLastName: "",
        providerUserEmail: "ci-pipeline",
        providerUserPicture: "",
      }),
    ]

    const context = buildFlowContext(processExecutionId, baseDate, steps)

    expect(context.process.executionId).toBe(processExecutionId)
    expect(context.step["automatedStep"]?.user.sub).toBe("ci-pipeline")
    expect(context.step["automatedStep"]?.providerUser.name).toBe("ci-pipeline")
    expect(context.step["automatedStep"]?.providerUser.email).toBe(
      "ci-pipeline",
    )
  })
})
