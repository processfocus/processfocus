import { Cause, DateTime, Effect, Exit, Option } from "effect"
import { buildFlowContext } from "./flow-context"
import { Form } from "./form"
import { NodeStep } from "./node_step"
import { Organisation } from "./organisation"
import { Process } from "./process"
import { Role } from "./role"
import { type AuthorTaggedError, CurrentStepJobContext } from "./system-step"
import { makeSystemStepExecutor } from "./system-step-executor"
import { describe, expect, it } from "bun:test"

const createExecutor = (
  executeEffect: Effect.Effect<
    Record<string, unknown>,
    AuthorTaggedError,
    never
  >,
) => {
  const organisation = new Organisation({ name: "Test Organisation" })
  const role = new Role(organisation, "employee", { name: "Employee" })
  const process = new Process(organisation, "process", {
    name: "Test",
    purpose: "Test",
  })

  const submit = new Form(process, "submit", {
    role,
    form: () => ({}),
  })
  const system = new NodeStep(process, "system", {
    input: () => Effect.succeed({}),
    output: {},
    execute: () => executeEffect,
  })

  process.start(submit).next(system).end()

  return {
    executor: makeSystemStepExecutor(organisation),
    stepPath: system.node.path,
  }
}

const runExit = (effect: Effect.Effect<unknown, unknown, unknown>) =>
  Effect.runPromise(
    Effect.exit(effect as Effect.Effect<unknown, unknown, never>),
  )

const getFailure = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) {
    throw new Error("Expected system step execution to fail")
  }

  return Option.getOrUndefined(Cause.failureOption(exit.cause))
}

describe("SystemStepExecutor", () => {
  it("passes process execution id to system step input context", async () => {
    const processExecutionId = "pex-system-step-ctx"
    let actualExecutionId: string | undefined
    const organisation = new Organisation({ name: "Test Organisation" })
    const role = new Role(organisation, "employee", { name: "Employee" })
    const process = new Process(organisation, "process", {
      name: "Test",
      purpose: "Test",
    })

    const submit = new Form(process, "submit", {
      role,
      form: () => ({}),
    })
    const system = new NodeStep(process, "system", {
      input: (_state, ctx) =>
        Effect.succeed({ executionId: ctx.process.executionId }),
      output: {},
      execute: (input) =>
        Effect.sync(() => {
          actualExecutionId = input.executionId as string | undefined
          return {}
        }),
    })

    process.start(submit).next(system).end()

    const result = await Effect.runPromise(
      makeSystemStepExecutor(organisation).execute(
        system.node.path,
        {},
        buildFlowContext(processExecutionId, DateTime.unsafeNow(), []),
        "todo-1",
      ) as Effect.Effect<unknown, unknown, never>,
    )

    expect(result).toEqual({ _tag: "Completed", output: {} })
    expect(actualExecutionId).toBe(processExecutionId)
  })

  it("provides the current step job context while the step executes", async () => {
    let receivedContext: { todoId: string; stepPath: string } | undefined
    const organisation = new Organisation({ name: "Test Organisation" })
    const role = new Role(organisation, "employee", { name: "Employee" })
    const process = new Process(organisation, "process", {
      name: "Test",
      purpose: "Test",
    })

    const submit = new Form(process, "submit", {
      role,
      form: () => ({}),
    })
    const system = new NodeStep(process, "system", {
      input: () => Effect.succeed({}),
      output: {},
      execute: () =>
        Effect.gen(function* () {
          receivedContext = yield* CurrentStepJobContext
          return {}
        }),
    })

    process.start(submit).next(system).end()

    await Effect.runPromise(
      makeSystemStepExecutor(organisation).execute(
        system.node.path,
        {},
        buildFlowContext("pex-job-context", DateTime.unsafeNow(), []),
        "todo-persist-1",
      ) as Effect.Effect<unknown, unknown, never>,
    )

    expect(receivedContext).toEqual({
      todoId: "todo-persist-1",
      stepPath: system.node.path,
    })
  })

  it("preserves tagged domain errors", async () => {
    const taggedError = {
      _tag: "Retryable",
      message: "boom",
      error: { _tag: "Inner", message: "nested" },
    }
    const { executor, stepPath } = createExecutor(Effect.fail(taggedError))

    const exit = await runExit(
      executor.execute(
        stepPath,
        {},
        buildFlowContext("pex-test", DateTime.unsafeNow(), []),
        "todo-1",
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(getFailure(exit)).toEqual(taggedError)
  })
})
