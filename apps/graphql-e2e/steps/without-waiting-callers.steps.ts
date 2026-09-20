import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { When } from "@cucumber/cucumber"
import { Schema } from "effect"
import { decodeJwt } from "jose"
import { getEffectiveAuthUrl } from "@pf/frontend-endpoints/port-files"
import {
  runAuthenticate,
  runAuthenticateAsFrontend,
  runAuthenticateAsProviderUser,
  runAuthenticateWithRole,
} from "../support/auth-helpers"
import { sleep } from "../support/sleep"
import type { TestWorld } from "../support/world"

const tokenValue = (response: { access_token?: string }): string => {
  assert.ok(response.access_token, "Authentication must return an access token")
  return response.access_token
}
const tokenBody = Schema.decodeUnknownSync(
  Schema.Struct({ access_token: Schema.String }),
)
const secretBody = Schema.decodeUnknownSync(
  Schema.Struct({ secret: Schema.String }),
)

const authPost = async (
  path: string,
  token: string,
  body: unknown,
): Promise<unknown> => {
  const response = await fetch(`${getEffectiveAuthUrl()}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
  assert.equal(
    response.status,
    path === "/delegations" ? 201 : 200,
    `${path} must succeed`,
  )
  return response.json()
}

// Use the existing user-management API to assign real roles in this disposable
// database. Restore assignments even when a journey fails.
const withCaller = async (
  world: TestWorld,
  kind: string,
  scope: string,
  startRole: boolean,
  run: (actor: {
    token: string
    userId: string
    delegationName?: string
  }) => Promise<void>,
): Promise<void> => {
  assert.ok(
    !process.env["BASE_URL"],
    "Caller setup requires the disposable E2E runtime",
  )
  const adminToken = tokenValue(await runAuthenticate())
  if (kind === "service") {
    const role = !startRole
      ? "/Administrator"
      : scope === "none"
        ? "/Employee"
        : scope === "hierarchy"
          ? "/hr/Manager"
          : scope === "broad"
            ? "/operations/IT"
            : "/hr/HR"
    const token = tokenValue(await runAuthenticateWithRole(role))
    const payload = decodeJwt(token)
    assert.equal(payload["type"], "user")
    const properties = Schema.decodeUnknownSync(
      Schema.Struct({ userId: Schema.String, clientId: Schema.String }),
    )(payload["properties"])
    assert.equal(properties.clientId, "ci-pipeline")
    await run({ token, userId: properties.userId })
    return
  }
  const email =
    scope === "exact"
      ? "employee@example.com"
      : scope === "hierarchy"
        ? "finance-manager@example.com"
        : scope === "broad"
          ? "procurement-manager@example.com"
          : "ci@example.com"
  tokenValue(await runAuthenticateAsProviderUser(email))
  world.accessToken = adminToken
  const data = await world.executeGraphQL<{
    allRoles: { items: { id: string; path: string }[] }
    allUsers: { items: { id: string; providerUserEmail: string }[] }
  }>(
    `query { allRoles(limit: 100) { items { id path } } allUsers(limit: 100) { items { id providerUserEmail } } }`,
  )
  const user = data.allUsers.items.find(
    (item) => item.providerUserEmail === email,
  )
  assert.ok(user)
  const detail = await world.executeGraphQL<{
    userDetail: { providerUser: { id: string; roleIds: string[] } }
  }>(
    `query($id: ID!) { userDetail(userId: $id) { providerUser { id roleIds } } }`,
    { id: user.id },
  )
  const provider = detail.userDetail.providerUser
  const wanted = startRole ? ["/Employee", "/hr/HR"] : ["/finance/Manager"]
  if (scope === "default" || scope === "none") wanted.push("/Administrator")
  const update = async (roleIds: string[]) => {
    world.accessToken = adminToken
    const result = await world.executeGraphQL<{
      updateProviderUser: { __typename: string }
    }>(
      `mutation($id: ID!, $input: UpdateProviderUserInput!) { updateProviderUser(providerUserId: $id, input: $input) { __typename } }`,
      { id: provider.id, input: { roleIds } },
    )
    assert.equal(
      result.updateProviderUser.__typename,
      "UpdateProviderUserSuccess",
    )
  }
  await update(
    data.allRoles.items
      .filter((role) => wanted.includes(role.path))
      .map((role) => role.id),
  )
  try {
    let token = tokenValue(await runAuthenticate(`email:${email}`))
    let delegationName: string | undefined
    if (kind === "delegation") {
      delegationName = `schedule-${randomUUID()}`
      const issued = secretBody(
        await authPost("/delegations", token, {
          name: delegationName,
          lifetimeDays: 1,
        }),
      )
      const frontend = tokenValue(await runAuthenticateAsFrontend())
      token = tokenBody(
        await authPost("/oauth/delegation", frontend, {
          secret: issued.secret,
        }),
      ).access_token
    }
    const payload = decodeJwt(token)
    assert.equal(payload["type"], "providerUser")
    const properties = Schema.decodeUnknownSync(
      Schema.Struct({
        userId: Schema.String,
        email: Schema.String,
        delegation: Schema.optional(
          Schema.Struct({ id: Schema.String, name: Schema.String }),
        ),
      }),
    )(payload["properties"])
    assert.equal(properties.email, email)
    assert.equal(properties.userId, user.id)
    assert.equal(properties.delegation?.name, delegationName)
    await run({
      token,
      userId: provider.id,
      ...(delegationName ? { delegationName } : {}),
    })
  } finally {
    await update(provider.roleIds)
  }
}

const fixtures = [
  {
    path: "/hr/on-boarding",
    mutation: "startHrOnBoarding",
    input:
      ', input: { first_name: "Policy", last_name: "Matrix", start_date: "2099-01-01T00:00:00Z" }',
    immediate: "Background check",
    scheduled: "Create account",
  },
  {
    path: "/hr/automation/scheduled-start",
    mutation: "startHrAutomationScheduledStart",
    input: "",
    immediate: "Immediate",
    scheduled: "Scheduled",
  },
]

interface Execution {
  id: string
  withoutWaiting: boolean
  steps: {
    path: string
    status: string
    providerUser: { id: string; firstName: string } | null
  }[]
}
const readExecutions = async (world: TestWorld): Promise<Execution[]> =>
  (
    await world.executeGraphQL<{ pullExecution: { documents: Execution[] } }>(
      `query { pullExecution(limit: 100) { documents { id withoutWaiting steps { path status providerUser { id firstName } } } } }`,
    )
  ).pullExecution.documents

const eventually = async <T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
): Promise<T> => {
  const deadline = Date.now() + 30_000
  let value = await read()
  while (!ready(value) && Date.now() < deadline) {
    await sleep(200)
    value = await read()
  }
  assert.ok(ready(value), `Expected worker outcome: ${JSON.stringify(value)}`)
  return value
}
const waiting = (execution: Execution | undefined, step: string): boolean =>
  execution?.steps.some(
    (item) => item.path.endsWith(`/${step}`) && item.status === "Waiting",
  ) ?? false

const assertAbsent = async (world: TestWorld, id: string): Promise<void> => {
  world.accessToken = tokenValue(await runAuthenticate())
  const result = await world.executeGraphQL<{
    processStateForExecution: unknown
    hasPendingScheduledFlows: boolean
  }>(
    `query($id: ID!) { processStateForExecution(executionId: $id) hasPendingScheduledFlows(processExecutionId: $id) }`,
    { id },
  )
  assert.equal(result.processStateForExecution, null)
  assert.equal(result.hasPendingScheduledFlows, false)
}

When(
  "the {string} caller exercises the {string} schedule grant through both start shapes",
  { timeout: 180_000 },
  async function (this: TestWorld, kind: string, scope: string) {
    await withCaller(this, kind, scope, true, async (actor) => {
      this.accessToken = actor.token
      this.setUserSession("schedule-caller", actor.token)
      await this.subscribeUserToExecutions("schedule-caller")
      const capabilities = await this.executeGraphQL<{
        pullProcess: {
          documents: { path: string; canSkipScheduleWaits: boolean }[]
        }
      }>(
        `query { pullProcess(limit: 100) { documents { path canSkipScheduleWaits } } }`,
      )
      for (const path of [
        "/hr/on-boarding",
        "/hr/automation/scheduled-start",
        "/hr/time-off-request",
        "/operations/scheduled-start",
      ]) {
        const expected =
          scope === "broad" ||
          scope === "default" ||
          path === "/hr/on-boarding" ||
          path === "/hr/automation/scheduled-start" ||
          (scope === "hierarchy" && path === "/hr/time-off-request")
        assert.equal(
          capabilities.pullProcess.documents.find((item) => item.path === path)
            ?.canSkipScheduleWaits,
          expected,
          path,
        )
      }
      // Same-unit and outside-unit crafted requests must agree with capability.
      for (const other of [
        {
          path: "/hr/time-off-request",
          mutation: "startHrTimeOffRequest",
          input: ', input: { dates: "Future" }',
        },
        {
          path: "/operations/scheduled-start",
          mutation: "startOperationsScheduledStart",
          input: "",
        },
      ]) {
        this.accessToken = actor.token
        const id = `pex-${randomUUID()}`
        const allowed = capabilities.pullProcess.documents.find(
          (item) => item.path === other.path,
        )?.canSkipScheduleWaits
        const request = () =>
          this.executeGraphQL(
            `mutation($id: ID!) { ${other.mutation}(executionId: $id, withoutWaiting: true${other.input}) { executionId } }`,
            { id },
          )
        if (allowed) await request()
        else {
          await assert.rejects(request(), /not authorized/i)
          await assertAbsent(this, id)
        }
      }
      for (const fixture of fixtures) {
        this.accessToken = actor.token
        const start = async (mode: string) => {
          const id = `pex-${randomUUID()}`
          await this.executeGraphQL(
            `mutation($id: ID!) { ${fixture.mutation}(executionId: $id${mode}${fixture.input}) { executionId } }`,
            { id },
          )
          return id
        }
        const normal = await start("")
        const fast = await start(", withoutWaiting: true")
        await eventually(
          async () =>
            this.userSessions.get("schedule-caller")?.subscriptions.execution
              ?.events ?? [],
          (events) =>
            events.some((event) => {
              const data = Schema.decodeUnknownSync(
                Schema.Struct({
                  streamExecution: Schema.Struct({
                    documents: Schema.Array(
                      Schema.Struct({ id: Schema.String }),
                    ),
                  }),
                }),
              )(event.data)
              return data.streamExecution.documents.some(
                (document) => document.id === fast,
              )
            }),
        )
        const list = await this.executeGraphQL<{
          executions: { nodes: { id: string; withoutWaiting: boolean }[] }
        }>(
          `query($path: String!) { executions(processPath: $path, limit: 100) { nodes { id withoutWaiting } } }`,
          { path: fixture.path },
        )
        assert.equal(
          list.executions.nodes.find((item) => item.id === fast)
            ?.withoutWaiting,
          true,
        )
        const rows = await eventually(
          () => readExecutions(this),
          (items) =>
            waiting(
              items.find((item) => item.id === normal),
              fixture.immediate,
            ) &&
            waiting(
              items.find((item) => item.id === fast),
              fixture.scheduled,
            ),
        )
        const fastExecution = rows.find((item) => item.id === fast)
        const normalExecution = rows.find((item) => item.id === normal)
        assert.ok(fastExecution && normalExecution)
        assert.equal(fastExecution.withoutWaiting, true)
        assert.equal(normalExecution.withoutWaiting, false)
        assert.equal(waiting(normalExecution, fixture.scheduled), false)
        // Existing attribution retains the business user and delegated audit label.
        const starter = fastExecution.steps[0]?.providerUser
        if (kind === "service") assert.equal(starter, null)
        else assert.equal(starter?.id, actor.userId)
        if (actor.delegationName)
          assert.ok(starter?.firstName.includes(actor.delegationName))
        this.accessToken = tokenValue(await runAuthenticate())
        const state = await this.executeGraphQL<{
          processStateForExecution: Record<string, unknown>
          fastState: Record<string, unknown>
          hasPendingScheduledFlows: boolean
        }>(
          `query($id: ID!, $fast: ID!) { processStateForExecution(executionId: $id) fastState: processStateForExecution(executionId: $fast) hasPendingScheduledFlows(processExecutionId: $id) }`,
          { id: normal, fast },
        )
        assert.equal(state.hasPendingScheduledFlows, true)
        assert.deepEqual(state.fastState, state.processStateForExecution)
        assert.equal("withoutWaiting" in state.processStateForExecution, false)
        if (fixture.input)
          assert.equal(
            state.processStateForExecution["start_date"],
            "2099-01-01T00:00:00.000Z",
          )
        else assert.deepEqual(state.processStateForExecution, {})
        // Another ordinary participant can observe the persisted mode.
        const viewer = tokenValue(
          await runAuthenticateAsProviderUser("employee-2@example.com"),
        )
        this.accessToken = viewer
        const visible = await readExecutions(this)
        assert.equal(
          visible.find((item) => item.id === fast)?.withoutWaiting,
          true,
        )
        this.accessToken = actor.token
      }
    })
  },
)

When(
  "the {string} caller cannot select ungranted or invalid schedule modes",
  { timeout: 120_000 },
  async function (this: TestWorld, kind: string) {
    await withCaller(this, kind, "none", true, async (actor) => {
      const noInput = fixtures[1]
      assert.ok(noInput)
      this.accessToken = actor.token
      const capability = await this.executeGraphQL<{
        pullProcess: {
          documents: { path: string; canSkipScheduleWaits: boolean }[]
        }
      }>(
        `query { pullProcess(limit: 100) { documents { path canSkipScheduleWaits } } }`,
      )
      assert.equal(
        capability.pullProcess.documents.find(
          (item) => item.path === noInput.path,
        )?.canSkipScheduleWaits,
        false,
      )
      for (const fixture of kind === "service" ? [noInput] : fixtures) {
        this.accessToken = actor.token
        const id = `pex-${randomUUID()}`
        await assert.rejects(
          this.executeGraphQL(
            `mutation($id: ID!) { ${fixture.mutation}(executionId: $id, withoutWaiting: true${fixture.input}) { executionId } }`,
            { id },
          ),
          /not authorized/i,
        )
        await assertAbsent(this, id)
        this.accessToken = actor.token
        await this.executeGraphQL(
          `mutation { ${fixture.mutation}(${fixture.input ? fixture.input.slice(2) : "withoutWaiting: false"}) { executionId } }`,
        )
      }
      for (const fixture of fixtures) {
        for (const mode of ["true", 1, {}]) {
          this.accessToken = actor.token
          const id = `pex-${randomUUID()}`
          await assert.rejects(
            this.executeGraphQL(
              `mutation($id: ID!, $mode: Boolean) { ${fixture.mutation}(executionId: $id, withoutWaiting: $mode${fixture.input}) { executionId } }`,
              { id, mode },
            ),
            /Boolean/i,
          )
          await assertAbsent(this, id)
        }
      }
    })
  },
)

When(
  "the {string} caller has mode permission but cannot bypass ordinary start authorization",
  { timeout: 90_000 },
  async function (this: TestWorld, kind: string) {
    await withCaller(this, kind, "broad", false, async (actor) => {
      for (const fixture of fixtures) {
        this.accessToken = actor.token
        const capabilities = await this.executeGraphQL<{
          pullProcess: {
            documents: { path: string; canSkipScheduleWaits: boolean }[]
          }
        }>(
          `query { pullProcess(limit: 100) { documents { path canSkipScheduleWaits } } }`,
        )
        assert.equal(
          capabilities.pullProcess.documents.some(
            (item) => item.path === fixture.path,
          ),
          false,
        )
        for (const mode of [true, false]) {
          const id = `pex-${randomUUID()}`
          this.accessToken = actor.token
          await assert.rejects(
            this.executeGraphQL(
              `mutation($id: ID!) { ${fixture.mutation}(executionId: $id, withoutWaiting: ${mode}${fixture.input}) { executionId } }`,
              { id },
            ),
            /not authorized/i,
          )
          await assertAbsent(this, id)
        }
      }
    })
  },
)
