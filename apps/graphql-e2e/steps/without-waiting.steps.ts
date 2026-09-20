import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { Then, When } from "@cucumber/cucumber"
import { runAuthenticateWithRole } from "../support/auth-helpers"
import { sleep } from "../support/sleep"
import type { TestWorld } from "../support/world"

interface Execution {
  id: string
  withoutWaiting: boolean
  status: string
  startedAt: string
  finishedAt: string | null
  steps: { id: string; path: string; status: string; name: string }[]
}

declare module "../support/world" {
  interface TestWorld {
    rejectedWithoutWaitingId?: string
  }
}

export const executions = async (world: TestWorld): Promise<Execution[]> => {
  const result = await world.executeGraphQL<{
    pullExecution: { documents: Execution[] }
  }>(`query {
    pullExecution(limit: 100) { documents { id withoutWaiting status startedAt finishedAt steps { id path status name } } }
  }`)
  return result.pullExecution.documents
}

export const eventually = async <T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
): Promise<T> => {
  const deadline = Date.now() + 30_000
  let value = await read()
  while (!ready(value) && Date.now() < deadline) {
    await sleep(200)
    value = await read()
  }
  assert.ok(
    ready(value),
    `Worker did not reach expected state: ${JSON.stringify(value)}`,
  )
  return value
}

export const asRole = async (world: TestWorld, role: string): Promise<void> => {
  const token = await runAuthenticateWithRole(role)
  assert.ok(token.access_token, `Could not acquire ${role}`)
  world.accessToken = token.access_token
}

export const startOnboarding = async (
  world: TestWorld,
  withoutWaiting: boolean,
  startDate: string,
): Promise<string> => {
  const result = await world.executeGraphQL<{
    startHrOnBoarding: { executionId: string }
  }>(
    `mutation($input: HrOnBoardingSendWelcomePack!, $withoutWaiting: Boolean!) {
    startHrOnBoarding(input: $input, withoutWaiting: $withoutWaiting) { executionId }
  }`,
    {
      input: {
        first_name: "Future",
        last_name: "Colleague",
        start_date: startDate,
      },
      withoutWaiting,
    },
  )
  return result.startHrOnBoarding.executionId
}

export const executionById = (items: Execution[], id: string): Execution => {
  const execution = items.find((item) => item.id === id)
  assert.ok(execution, `Missing execution ${id}`)
  return execution
}

export const step = (execution: Execution, name: string) =>
  execution.steps.find((item) => item.path.endsWith(`/${name}`))

When(
  "I walk onboarding without waiting with performance outcome {string}",
  { timeout: 180_000 },
  async function (this: TestWorld, outcome: string) {
    await asRole(this, "/hr/HR")
    const before = Date.now()
    const startDate = new Date(before + 21 * 86400000).toISOString()
    const normalId = await startOnboarding(this, false, startDate)
    const fastId = await startOnboarding(this, true, startDate)
    const initial = [
      "Background check",
      "Create account",
      "Assign desk",
      "Assign ID badge",
      "Onboarding checklist",
      "Orientation session",
      "Review 30-60-90 day plan",
    ]
    const rows = await eventually(
      () => executions(this),
      (items) => {
        const fast = items.find((item) => item.id === fastId)
        const normal = items.find((item) => item.id === normalId)
        return (
          !!fast &&
          !!normal &&
          initial.every((name) => step(fast, name)?.status === "Waiting") &&
          step(normal, "Background check")?.status === "Waiting"
        )
      },
    )
    const fast = executionById(rows, fastId)
    const normal = executionById(rows, normalId)
    assert.equal(fast.withoutWaiting, true)
    assert.equal(normal.withoutWaiting, false)
    assert.ok(new Date(fast.startedAt).getTime() >= before - 1000)
    // The background Todo proves the normal execution's initial worker transaction
    // committed. Its sibling scheduled transitions remain deferred in that batch.
    for (const name of initial.slice(1))
      assert.notEqual(step(normal, name)?.status, "Waiting")
    for (const name of [
      "Provision laptop",
      "Provide laptop and badge",
      "Compliance training",
      "Day 30 check-in",
    ])
      assert.notEqual(step(fast, name)?.status, "Waiting")

    const complete = async (
      name: string,
      suffix: string,
      role: string,
      input?: Record<string, boolean>,
    ) => {
      await asRole(this, "/hr/HR")
      const ready = await eventually(
        () => executions(this),
        (items) => {
          const execution = items.find((item) => item.id === fastId)
          return !!execution && step(execution, name)?.status === "Waiting"
        },
      )
      const todo = step(executionById(ready, fastId), name)
      assert.ok(todo)
      await asRole(this, role)
      await this.executeGraphQL(
        `mutation($todoId: ID!${input ? `, $input: HrOnBoarding${suffix}!` : ""}) {
      completeHrOnBoarding${suffix}(todoId: $todoId${input ? ", input: $input" : ""}) { executionId }
    }`,
        { todoId: todo.id, ...(input ? { input } : {}) },
      )
    }
    await complete("Create account", "CreateAccount", "/operations/IT")
    await complete("Provision laptop", "ProvisionLaptop", "/operations/IT")
    await complete(
      "Provide laptop and badge",
      "ProvideLaptopAndBadge",
      "/operations/IT",
    )
    await complete(
      "Orientation session",
      "OrientationSession",
      "/hr/Hiring manager",
    )
    await complete(
      "Compliance training",
      "ComplianceTraining",
      "/hr/New employee",
    )
    await complete(
      "Review 30-60-90 day plan",
      "Review306090DayPlan",
      "/hr/Hiring manager",
    )
    await complete("Day 30 check-in", "Day30CheckIn", "/hr/Hiring manager")
    await complete(
      "Formal performance review",
      "FormalPerformanceReview",
      "/hr/Hiring manager",
      { passed: outcome === "passed" },
    )
    await asRole(this, "/hr/HR")
    const branchName = outcome === "passed" ? "Passed" : "Probation failed"
    const branchRows = await eventually(
      () => executions(this),
      (items) => {
        const execution = items.find((item) => item.id === fastId)
        return !!execution && step(execution, branchName)?.status === "Waiting"
      },
    )
    assert.notEqual(
      step(
        executionById(branchRows, fastId),
        outcome === "passed" ? "Probation failed" : "Passed",
      )?.status,
      "Waiting",
    )
    await complete(
      branchName,
      outcome === "passed" ? "Passed" : "ProbationFailed",
      "/hr/Hiring manager",
      outcome === "passed"
        ? undefined
        : { start_offboarding: false, start_improvement_process: true },
    )
    await complete("Background check", "BackgroundCheck", "/hr/HR")
    await complete("Assign desk", "AssignDesk", "/hr/HR")
    await complete("Assign ID badge", "AssignIdBadge", "/hr/HR")
    await complete(
      "Onboarding checklist",
      "OnboardingChecklist",
      "/hr/Hiring manager",
    )
    await asRole(this, "/hr/HR")
    const final = await eventually(
      () => executions(this),
      (items) =>
        items.some(
          (item) =>
            item.id === fastId &&
            item.status === "Completed" &&
            item.finishedAt !== null,
        ),
    )
    const completed = executionById(final, fastId)
    assert.equal(completed.withoutWaiting, true)
    assert.ok(
      completed.finishedAt &&
        new Date(completed.finishedAt).getTime() <= Date.now() + 1000,
    )
    const state = await this.executeGraphQL<{
      processStateForExecution: { start_date: string }
    }>(`query($id: ID!) { processStateForExecution(executionId: $id) }`, {
      id: fastId,
    })
    assert.equal(
      new Date(state.processStateForExecution.start_date).toISOString(),
      startDate,
    )
    assert.equal(final.find((item) => item.id === normalId)?.status, "Running")
    const pending = await this.executeGraphQL<{
      hasPendingScheduledFlows: boolean
    }>(
      `query($id: ID!) { hasPendingScheduledFlows(processExecutionId: $id) }`,
      { id: normalId },
    )
    assert.equal(pending.hasPendingScheduledFlows, true)
  },
)

When(
  "I attempt onboarding without waiting without its start role",
  async function (this: TestWorld) {
    this.rejectedWithoutWaitingId = `pex-${randomUUID()}`
    await assert.rejects(
      this.executeGraphQL(
        `mutation($id: ID!) {
    startHrOnBoarding(executionId: $id, withoutWaiting: true, input: { first_name: "Denied", last_name: "Start", start_date: "2099-01-01T00:00:00Z" }) { executionId }
  }`,
        { id: this.rejectedWithoutWaitingId },
      ),
      /not authorized/i,
    )
  },
)
When(
  "I attempt a purchase request without waiting",
  async function (this: TestWorld) {
    this.rejectedWithoutWaitingId = `pex-${randomUUID()}`
    await assert.rejects(
      this.executeGraphQL(
        `mutation($id: ID!) {
    startFinancePurchaseRequest(executionId: $id, withoutWaiting: true, input: { item: "Denied", value: "150" }) { executionId }
  }`,
        { id: this.rejectedWithoutWaitingId },
      ),
      /not authorized/i,
    )
  },
)
Then(
  "no rejected execution or scheduled work exists",
  async function (this: TestWorld) {
    assert.ok(this.rejectedWithoutWaitingId)
    const pending = await this.executeGraphQL<{
      hasPendingScheduledFlows: boolean
      processStateForExecution: unknown
    }>(
      `query($id: ID!) {
    hasPendingScheduledFlows(processExecutionId: $id) processStateForExecution(executionId: $id)
  }`,
      { id: this.rejectedWithoutWaitingId },
    )
    assert.equal(pending.hasPendingScheduledFlows, false)
    assert.equal(pending.processStateForExecution, null)
  },
)
