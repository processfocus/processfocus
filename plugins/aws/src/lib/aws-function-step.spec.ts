import { Effect, Schema } from "effect"
import { OrgUnit, Organisation, Process } from "@pf/process"
import { AwsFunctionStep } from "./aws-function-step"
import { describe, expect, it } from "bun:test"

describe("AwsFunctionStep", () => {
  const org = new Organisation({ name: "TestOrg" })
  const unit = new OrgUnit(org, "test-unit", { name: "Test Unit" })

  it("should construct with functionName property", () => {
    const process = new Process(unit, "TestProcess", {
      name: "Test Process",
      purpose: "Testing AwsFunctionStep",
    })

    const step = new AwsFunctionStep(process, "AddNumbers", {
      functionName: "demo-add-numbers",
      input: () => Effect.succeed({ a: 1, b: 2 }),
      output: { result: Schema.Number },
    })

    expect(step.functionName).toBe("demo-add-numbers")
    expect(step.isSystemStep).toBe(true)
  })

  it("should have isSystemStep === true", () => {
    const process = new Process(unit, "TestProcess2", {
      name: "Test Process 2",
      purpose: "Testing",
    })

    const step = new AwsFunctionStep(process, "TestStep", {
      functionName: "test-function",
      input: () => Effect.succeed({}),
      output: {},
    })

    expect(step.isSystemStep).toBe(true)
  })

  it("should support function ARN as functionName", () => {
    const process = new Process(unit, "TestProcess3", {
      name: "Test Process 3",
      purpose: "Testing",
    })

    const arn = "arn:aws:lambda:us-east-1:123456789012:function:my-function"
    const step = new AwsFunctionStep(process, "ArnStep", {
      functionName: arn,
      input: () => Effect.succeed({}),
      output: {},
    })

    expect(step.functionName).toBe(arn)
  })

  it("should extend SystemStep", () => {
    const process = new Process(unit, "TestProcess4", {
      name: "Test Process 4",
      purpose: "Testing",
    })

    const step = new AwsFunctionStep(process, "SystemTest", {
      functionName: "my-lambda",
      input: () => Effect.succeed({}),
      output: {},
    })

    // Verify it has the SystemStep interface
    expect(typeof step.executeWithInput).toBe("function")
    expect(typeof step.execute).toBe("function")
    expect(typeof step.input).toBe("function")
  })
})
