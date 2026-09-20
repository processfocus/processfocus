import { ExecutorHost } from "@processfocus/runtime"
import { Effect, Schema } from "effect"
import {
  OrgUnit,
  Organisation,
  Process,
  type StepJobContext,
} from "@pf/process"
import { DockerStep } from "./docker-step"
import { describe, expect, it } from "bun:test"

describe("DockerStep", () => {
  const org = new Organisation({ name: "TestOrg" })
  const unit = new OrgUnit(org, "test-unit", { name: "Test Unit" })

  it("should construct with docker metadata", () => {
    const process = new Process(unit, "TestProcess", {
      name: "Test Process",
      purpose: "Testing DockerStep",
    })

    const step = new DockerStep(process, "DeployStore", {
      dockerContext: "src/docker/deploy-project",
      input: () =>
        Effect.succeed({ artifactUrl: "https://example.com/store.zip" }),
      output: { stackId: Schema.String },
    })

    expect(step.dockerContext).toBe("src/docker/deploy-project")
    expect(step.dockerfile).toBe("Dockerfile")
    expect(step.isDockerStep).toBe(true)
    expect(step.isSystemStep).toBe(true)
  })

  it("delegates execution to the provider-neutral executor host", async () => {
    const process = new Process(unit, "DispatchProcess", {
      name: "Dispatch Process",
      purpose: "Testing DockerStep dispatch",
    })

    const step = new DockerStep(process, "DeployStore", {
      dockerContext: "src/docker/deploy-project",
      dockerfile: "Dockerfile.deploy",
      input: () =>
        Effect.succeed({ artifactUrl: "https://example.com/store.zip" }),
      output: { stackId: Schema.String },
    })

    const jobContext: StepJobContext = {
      stepPath: "test-unit/DispatchProcess/DeployStore",
      todoId: "todo-123",
    }
    const input = { artifactUrl: "https://example.com/store.zip" }
    const expectedResult = { _tag: "Deferred" } as const

    let receivedInvocation: unknown
    let receivedContext: StepJobContext | undefined

    const program = step.executeStep(input, jobContext).pipe(
      Effect.provideService(ExecutorHost, {
        run: (invocation, context) => {
          receivedInvocation = invocation
          receivedContext = context
          return Effect.succeed(expectedResult)
        },
      }),
    ) as Effect.Effect<typeof expectedResult, never, never>

    const result = await Effect.runPromise(program)

    expect(result).toEqual(expectedResult)
    expect(receivedInvocation).toEqual({
      source: {
        context: "src/docker/deploy-project",
        definition: "Dockerfile.deploy",
      },
      input,
    })
    expect(receivedContext).toEqual(jobContext)
  })
})
