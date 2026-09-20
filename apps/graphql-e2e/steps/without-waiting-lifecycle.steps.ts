import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { stripVTControlCharacters } from "node:util"
import { When } from "@cucumber/cucumber"
import {
  runAuthenticate,
  runAuthenticateAsProviderUser,
} from "../support/auth-helpers"
import {
  createLifecycleControlFile as controlFile,
  getLocalWorkerOutput,
  restartLocalRuntime,
  setStarterModeRevoked,
} from "../support/hooks"
import { sleep } from "../support/sleep"
import type { TestWorld } from "../support/world"
import {
  asRole,
  eventually,
  executionById,
  executions,
  startOnboarding,
  step,
} from "./without-waiting.steps"

const required = <T>(value: T | undefined): T => {
  assert.ok(value !== undefined)
  return value
}

const attempts = async (file: string): Promise<string[]> => {
  try {
    return (await readFile(`${file}.attempts`, "utf8")).trim().split("\n")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return []
    throw error
  }
}
const start = async (
  world: TestWorld,
  control: string,
  withoutWaiting: boolean,
  process = "Lifecycle",
) => {
  const result = await world.executeGraphQL<
    Record<string, { executionId: string }>
  >(
    `mutation($input: ${process}Submit!, $withoutWaiting: Boolean!) { start${process}(input: $input, withoutWaiting: $withoutWaiting) { executionId } }`,
    { input: { control }, withoutWaiting },
  )
  const started = result[`start${process}`]
  assert.ok(started)
  return started.executionId
}
const ready = async (
  world: TestWorld,
  id: string,
  name: string,
  status = "Waiting",
) => {
  const rows = await eventually(
    () => executions(world),
    (rows) => rows.some((e) => e.id === id && step(e, name)?.status === status),
  )
  return executionById(rows, id)
}
const complete = async (
  world: TestWorld,
  todoId: string,
  name: string,
  process = "Lifecycle",
) =>
  world.executeGraphQL(
    `mutation($id: ID!) { complete${process}${name}(todoId: $id) { executionId } }`,
    { id: todoId },
  )
const restart = async (world: TestWorld, id: string) => {
  const result = await world.executeGraphQL<{
    restartExecution: {
      success: boolean
      restartedCount: number
      error: string | null
    }
  }>(
    `mutation($id: ID!) { restartExecution(executionId: $id) { success restartedCount error } }`,
    { id },
  )
  return result.restartExecution
}

// Change actual persisted role membership through the public administration API.
// Obtain a fresh human token after each change; the starter is the CI service account.
const participant = async (
  world: TestWorld,
  canRestart: boolean,
  additionalRoles: string[] = [],
) => {
  const sa = await runAuthenticate()
  assert.ok(sa.access_token)
  world.accessToken = sa.access_token
  await runAuthenticateAsProviderUser("ci@example.com")
  const data = await world.executeGraphQL<{
    allRoles: { items: { id: string; path: string }[] }
    allUsers: { items: { id: string; providerUserEmail: string }[] }
  }>(
    `query { allRoles(limit:100) { items { id path } } allUsers(limit:100) { items { id providerUserEmail } } }`,
  )
  const user = data.allUsers.items.find(
    (u) => u.providerUserEmail === "ci@example.com",
  )
  assert.ok(user)
  const detail = await world.executeGraphQL<{
    userDetail: { providerUser: { id: string } }
  }>(`query($id:ID!) { userDetail(userId:$id) { providerUser { id } } }`, {
    id: user.id,
  })
  const wanted = [
    ...(canRestart ? ["/Employee", "/hr/HR"] : ["/Employee"]),
    ...additionalRoles,
  ]
  const update = await world.executeGraphQL<{
    updateProviderUser: { __typename: string }
  }>(
    `mutation($id:ID!, $input:UpdateProviderUserInput!) { updateProviderUser(providerUserId:$id,input:$input) { __typename } }`,
    {
      id: detail.userDetail.providerUser.id,
      input: {
        roleIds: data.allRoles.items
          .filter((r) => wanted.includes(r.path))
          .map((r) => r.id),
      },
    },
  )
  assert.equal(
    update.updateProviderUser.__typename,
    "UpdateProviderUserSuccess",
  )
  const human = await runAuthenticate("email:ci@example.com")
  assert.ok(human.access_token)
  world.accessToken = human.access_token
}

When(
  "I continue a durable Without Waiting execution across a runtime restart",
  { timeout: 180_000 },
  async function (this: TestWorld) {
    await asRole(this, "/Employee")
    const file = await controlFile("success")
    const normalFile = await controlFile("success")
    const before = Date.now()
    const normalId = await start(this, normalFile, false)
    const id = await start(this, file, true)
    const initial = await ready(this, id, "Gate")
    await ready(this, normalId, "Witness")
    await complete(this, required(step(initial, "Witness")).id, "Witness")
    await setStarterModeRevoked(true)
    await restartLocalRuntime()
    await assert.rejects(start(this, file, true), /not authorized/i)
    // Current policy still permits this caller to submit ordinary work.
    await start(this, await controlFile("success"), false)
    await participant(this, false)
    await assert.rejects(start(this, file, true), /not authorized/i)
    const recovered = await ready(this, id, "Gate")
    assert.equal(recovered.id, id)
    assert.equal(recovered.withoutWaiting, true)
    assert.equal(recovered.startedAt, initial.startedAt)
    assert.ok(new Date(recovered.startedAt).getTime() >= before - 1000)
    assert.equal(step(recovered, "Witness")?.status, "Completed")
    for (const name of ["Never", "Clock", "Item", "After"])
      assert.ok(
        !step(recovered, name) || step(recovered, name)?.status === "Potential",
      )
    assert.equal(step(recovered, "Alternate")?.status, "Waiting")
    await complete(this, required(step(recovered, "Gate")).id, "Gate")
    const fanout = await ready(this, id, "Item")
    const items = fanout.steps.filter((s) => s.path.endsWith("/Item"))
    assert.equal(items.length, 2)
    const barrierChecksBefore = (
      getLocalWorkerOutput().match(/forEach barrier check/g) ?? []
    ).length
    await complete(this, required(items[0]).id, "Item")
    await ready(this, id, "Item", "Completed")
    await eventually(
      async () => stripVTControlCharacters(getLocalWorkerOutput()),
      (output) => {
        const checks = output.split("forEach barrier check")
        return (
          checks.length - 1 > barrierChecksBefore &&
          /activeSiblings:\s+1/.test(checks.at(-1) ?? "")
        )
      },
    )
    // A completed item is a positive worker witness. The other item and barrier
    // remain unchanged for a bounded window, including after process restart.
    await restartLocalRuntime()
    const blocked = executionById(await executions(this), id)
    assert.equal(
      blocked.steps.filter(
        (s) => s.path.endsWith("/Item") && s.status === "Waiting",
      ).length,
      1,
    )
    assert.ok(
      !step(blocked, "After") || step(blocked, "After")?.status === "Potential",
    )
    await complete(this, required(items[1]).id, "Item")
    const after = await ready(this, id, "After")
    await complete(this, required(step(after, "After")).id, "After")
    await complete(this, required(step(after, "Alternate")).id, "Alternate")
    const final = await eventually(
      () => executions(this),
      (rows) => rows.some((e) => e.id === id && e.status === "Completed"),
    )
    assert.equal(executionById(final, id).withoutWaiting, true)
    assert.equal(
      (await attempts(file)).length,
      1,
      "Restart must not replay a completed scheduled action",
    )
    assert.equal((await attempts(normalFile)).length, 0)
    const normal = executionById(final, normalId)
    assert.equal(normal.withoutWaiting, false)
    assert.equal(normal.status, "Running")
    assert.ok(
      !step(normal, "Action") || step(normal, "Action")?.status === "Potential",
    )
    await setStarterModeRevoked(false)
    await restartLocalRuntime()
  },
)

When(
  "an ordinary participant recovers a failed Without Waiting execution",
  { timeout: 120_000 },
  async function (this: TestWorld) {
    await asRole(this, "/Employee")
    const file = await controlFile("terminal")
    const id = await start(this, file, true)
    const failed = await ready(this, id, "Action", "Failed")
    assert.equal(failed.status, "Failed")
    assert.ok(
      !step(failed, "Gate") || step(failed, "Gate")?.status === "Potential",
    )
    await participant(this, false)
    const denied = await restart(this, id)
    assert.equal(denied.success, false)
    assert.match(denied.error ?? "", /not authorized/i)
    await participant(this, true)
    await assert.rejects(start(this, file, true), /not authorized/i)
    await writeFile(file, "success")
    await restartLocalRuntime()
    const result = await restart(this, id)
    assert.equal(result.success, true, result.error ?? "restart failed")
    assert.equal(result.restartedCount, 1)
    const recovered = await ready(this, id, "Gate")
    assert.equal(recovered.id, id)
    assert.equal(recovered.withoutWaiting, true)
    assert.equal(recovered.startedAt, failed.startedAt)
    assert.equal(recovered.status, "Running")
    assert.equal(step(recovered, "Action")?.id, step(failed, "Action")?.id)
    assert.equal((await attempts(file)).length, 2)
  },
)

When(
  "a Without Waiting failure takes its authored error branch",
  { timeout: 60_000 },
  async function (this: TestWorld) {
    await asRole(this, "/Employee")
    const file = await controlFile("terminal")
    const id = await start(this, file, true, "Handled")
    const row = await ready(this, id, "Recovered")
    assert.equal(row.status, "Running")
    assert.equal(step(row, "Action")?.status, "Failed")
    assert.ok(!step(row, "Gate") || step(row, "Gate")?.status === "Potential")
    assert.equal(step(row, "Witness")?.status, "Waiting")
    await complete(
      this,
      required(step(row, "Recovered")).id,
      "Recovered",
      "Handled",
    )
    await ready(this, id, "Recovered", "Completed")
    assert.equal((await attempts(file)).length, 1)
  },
)

When(
  "invalid schedules are evaluated in both execution modes",
  { timeout: 60_000 },
  async function (this: TestWorld) {
    await asRole(this, "/Employee")
    for (const withoutWaiting of [false, true]) {
      const invalidDate = `invalid-${randomUUID()}`
      const data = await this.executeGraphQL<{
        startInvalidSchedule: { executionId: string }
      }>(
        `mutation($mode:Boolean!, $date:String!) { startInvalidSchedule(input:{date:$date},withoutWaiting:$mode) { executionId } }`,
        { mode: withoutWaiting, date: invalidDate },
      )
      await eventually(
        async () => getLocalWorkerOutput(),
        (output) =>
          output.includes(
            `ScheduleEvaluationError: Invalid authored schedule: ${invalidDate}`,
          ),
      )
      const id = data.startInvalidSchedule.executionId
      const row = executionById(await executions(this), id)
      assert.equal(row.withoutWaiting, withoutWaiting)
      assert.ok(
        !step(row, "Target") || step(row, "Target")?.status === "Potential",
      )
      const pending = await this.executeGraphQL<{
        hasPendingScheduledFlows: boolean
      }>(`query($id:ID!){hasPendingScheduledFlows(processExecutionId:$id)}`, {
        id,
      })
      assert.equal(pending.hasPendingScheduledFlows, true)
    }
  },
)

When(
  "a Without Waiting action retries through the ordinary queue delay",
  { timeout: 90_000 },
  async function (this: TestWorld) {
    await asRole(this, "/Employee")
    const file = await controlFile("retry")
    const id = await start(this, file, true)
    await eventually(
      () => attempts(file),
      (values) => values.length === 1,
    )
    await writeFile(file, "success")
    const witness = await ready(this, id, "Witness")
    await complete(this, required(step(witness, "Witness")).id, "Witness")
    await ready(this, id, "Witness", "Completed")
    // Public Todo completion and the external action journal witness that unrelated
    // queues progress while this retry is not eligible. Do not move the clock.
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      assert.equal((await attempts(file)).length, 1)
      assert.notEqual(
        step(executionById(await executions(this), id), "Gate")?.status,
        "Waiting",
      )
      await sleep(200)
    }
    await ready(this, id, "Gate")
    const times = await attempts(file)
    assert.equal(times.length, 2)
    assert.ok(
      Date.parse(required(times[1])) - Date.parse(required(times[0])) >= 29_000,
      "Operational 30-second visibility interval must survive Without Waiting",
    )
  },
)

When(
  "another participant continues onboarding after starter revocation and runtime restart",
  { timeout: 120_000 },
  async function (this: TestWorld) {
    await asRole(this, "/hr/HR")
    const startDate = new Date(Date.now() + 21 * 86_400_000).toISOString()
    const normalId = await startOnboarding(this, false, startDate)
    const id = await startOnboarding(this, true, startDate)
    const initial = await ready(this, id, "Create account")
    await ready(this, normalId, "Background check")
    await asRole(this, "/operations/IT")
    await this.executeGraphQL(
      `mutation($id:ID!){completeHrOnBoardingCreateAccount(todoId:$id){executionId}}`,
      { id: required(step(initial, "Create account")).id },
    )
    await asRole(this, "/hr/HR")
    await ready(this, id, "Provision laptop")
    await setStarterModeRevoked(true)
    await restartLocalRuntime()
    await assert.rejects(
      startOnboarding(this, true, startDate),
      /not authorized/i,
    )
    await participant(this, false, ["/hr/HR", "/hr/Hiring manager"])
    await assert.rejects(
      startOnboarding(this, true, startDate),
      /not authorized/i,
    )
    const continued = await ready(this, id, "Review 30-60-90 day plan")
    await this.executeGraphQL(
      `mutation($id:ID!){completeHrOnBoardingReview306090DayPlan(todoId:$id){executionId}}`,
      { id: required(step(continued, "Review 30-60-90 day plan")).id },
    )
    const day30 = await ready(this, id, "Day 30 check-in")
    assert.equal(day30.id, id)
    assert.equal(day30.withoutWaiting, true)
    assert.equal(day30.startedAt, initial.startedAt)
    assert.equal(step(day30, "Create account")?.status, "Completed")
    await asRole(this, "/hr/HR")
    const state = await this.executeGraphQL<{
      processStateForExecution: { start_date: string }
    }>(`query($id:ID!){processStateForExecution(executionId:$id)}`, { id })
    assert.equal(
      new Date(state.processStateForExecution.start_date).toISOString(),
      startDate,
    )
    const normal = executionById(await executions(this), normalId)
    assert.equal(normal.withoutWaiting, false)
    assert.equal(normal.status, "Running")
    assert.notEqual(step(normal, "Create account")?.status, "Waiting")
    assert.notEqual(step(normal, "Day 30 check-in")?.status, "Waiting")
  },
)
