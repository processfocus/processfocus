import assert from "node:assert/strict"
import { expect } from "@playwright/test"
import {
  getEffectiveAuthUrl,
  getEffectiveGraphqlEndpoint,
} from "@pf/frontend-endpoints/port-files"
import { Given, Then, When, test } from "./fixtures"

const record = (value: unknown): Record<string, unknown> => {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  )
  return Object.fromEntries(Object.entries(value))
}

Given(
  /^I use the disposable (onboarding|exact-process|hierarchy|broad) browser account (with|without|with restart but without) Administrator permission$/,
  async (
    { authenticateAsProviderUser, context, baseURL },
    grant: string,
    mode: string,
  ) => {
    test.setTimeout(120_000)
    assert.ok(
      baseURL && new URL(baseURL).hostname === "localhost",
      "Account setup is disposable-local only",
    )
    const email =
      grant === "exact-process"
        ? "employee@example.com"
        : grant === "hierarchy"
          ? "finance-manager@example.com"
          : grant === "broad"
            ? "procurement-manager@example.com"
            : "ci@example.com"
    await authenticateAsProviderUser(email, undefined, "ci-pipeline")
    const auth = await fetch(`${getEffectiveAuthUrl()}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`ci-pipeline:${process.env["CI_PIPELINE_SECRET"] ?? "ci-pipeline-secret"}`).toString("base64")}`,
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    })
    const token = record(await auth.json())["access_token"]
    assert.equal(typeof token, "string")
    const query = async (
      query: string,
      variables?: Record<string, unknown>,
    ) => {
      const response = await fetch(getEffectiveGraphqlEndpoint(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query, variables }),
      })
      const body = record(await response.json())
      expect(body["errors"]).toBeUndefined()
      return record(body["data"])
    }
    const data = await query(
      `query { allRoles(limit: 100) { items { id path } } allUsers(limit: 100) { items { id providerUserEmail } } }`,
    )
    const roles = record(data["allRoles"])["items"]
    const users = record(data["allUsers"])["items"]
    assert.ok(Array.isArray(roles) && Array.isArray(users))
    const user = users
      .map(record)
      .find((item) => item["providerUserEmail"] === email)
    assert.ok(user)
    const detail = await query(
      `query($id: ID!) { userDetail(userId: $id) { providerUser { id } } }`,
      { id: user["id"] },
    )
    const providerUserId = record(record(detail["userDetail"])["providerUser"])[
      "id"
    ]
    const wanted =
      mode === "with"
        ? [
            "/Employee",
            "/Administrator",
            "/hr/HR",
            "/hr/Hiring manager",
            "/hr/New employee",
            "/operations/IT",
            "/operations/Facilities",
          ]
        : grant === "onboarding" && mode !== "with restart but without"
          ? ["/Employee"]
          : ["/Employee", "/hr/HR"]
    const roleIds = roles
      .map(record)
      .filter((role) => wanted.includes(String(role["path"])))
      .map((role) => role["id"])
    expect(roleIds).toHaveLength(wanted.length)
    const updated = await query(
      `mutation($id: ID!, $input: UpdateProviderUserInput!) { updateProviderUser(providerUserId: $id, input: $input) { __typename } }`,
      { id: providerUserId, input: { roleIds } },
    )
    expect(record(updated["updateProviderUser"])["__typename"]).toBe(
      "UpdateProviderUserSuccess",
    )
    await context.clearCookies()
    await authenticateAsProviderUser(email, undefined, "ci-pipeline")
  },
)

When("I open the onboarding start form", async ({ page }) => {
  await page.goto("/processes/start/hr/on-boarding/Send%20welcome%20pack")
  await expect(
    page.getByRole("button", { name: "Submit", exact: true }),
  ).toBeVisible()
})
Then("I see the plain Submit action", async ({ page }) => {
  await expect(
    page.getByRole("button", { name: "Submission options" }),
  ).toHaveCount(0)
})
Then("Without Waiting submits only after validation", async ({ page }) => {
  const submissions: string[] = []
  page.on("request", (request) => {
    if (request.postData()?.includes("mutation StartProcess"))
      submissions.push(request.postData() ?? "")
  })
  await page.getByRole("button", { name: "Submission options" }).click()
  await expect(
    page.getByRole("menuitem", { name: "Submit", exact: true }),
  ).toBeVisible()
  await page.getByRole("menuitem", { name: /^Submit without waiting/ }).click()
  await expect(
    page.getByRole("button", { name: "Submit", exact: true }),
  ).toBeVisible()
  await expect(page.getByText(/required|must|valid/i).first()).toBeVisible()
  expect(submissions).toHaveLength(0)
})
When("I fill a future onboarding form", async ({ page }) => {
  for (const [name, value] of [
    ["first_name", "Browser"],
    ["last_name", "Without Waiting"],
  ] as const) {
    await page.locator(`input[name="${name}"]`).fill(value)
  }
  await page
    .locator('input[name="start_date"]')
    .fill("2099-01-22T00:00:00.000Z")
})
When("I submit onboarding without waiting", async ({ page, scenarioState }) => {
  await page.getByRole("button", { name: "Submission options" }).click()
  const response = page.waitForResponse(
    (response) =>
      response.request().postData()?.includes("mutation StartProcess") === true,
  )
  await page.getByRole("menuitem", { name: /^Submit without waiting/ }).click()
  const result = record(await (await response).json())
  expect(result["errors"]).toBeUndefined()
  scenarioState.set(
    "withoutWaitingExecution",
    record(record(result["data"])["startHrOnBoarding"])["executionId"],
  )
})
Then(
  "the execution list and detail show Without waiting",
  async ({ page, scenarioState }) => {
    await page.goto("/executions")
    await expect(
      page.getByText("Without waiting", { exact: true }).first(),
    ).toBeVisible()
    const cardHeading = page
      .getByRole("heading", {
        level: 4,
        name: "Onboard a new employee Without waiting",
        exact: true,
      })
      .first()
    await expect(cardHeading.getByRole("button")).toHaveCount(0)
    const badge = cardHeading.getByText("Without waiting", { exact: true })
    await expect(badge).toHaveAttribute(
      "title",
      "Skip scheduled waits for this process run. Tasks and automated actions still run normally.",
    )
    await badge.hover()
    await expect(page.getByRole("tooltip")).toHaveText(
      "Skip scheduled waits for this process run. Tasks and automated actions still run normally.",
    )
    const id = scenarioState.get("withoutWaitingExecution")
    assert.equal(typeof id, "string")
    await page
      .getByRole("button", { name: /^Onboard a new employee Without waiting/ })
      .first()
      .click()
    await expect(
      page.getByRole("heading", {
        level: 3,
        name: "Onboard a new employee Without waiting",
        exact: true,
      }),
    ).toBeVisible()
  },
)
Then(
  "the main Submit action still starts an ordinary execution",
  async ({ page }) => {
    await page.locator('input[name="first_name"]').fill("Ordinary")
    await page.locator('input[name="last_name"]').fill("Browser")
    await page
      .locator('input[name="start_date"]')
      .fill("2099-01-22T00:00:00.000Z")
    const response = page.waitForResponse(
      (response) =>
        response.request().postData()?.includes("mutation StartProcess") ===
        true,
    )
    await page.getByRole("button", { name: "Submit", exact: true }).click()
    const received = await response
    const request = record(JSON.parse(received.request().postData() ?? "{}"))
    expect(record(request["variables"])["withoutWaiting"]).toBe(false)
    expect(record(await received.json())["errors"]).toBeUndefined()
  },
)

When("I save and reopen the onboarding draft", async ({ page }) => {
  const saved = page.waitForResponse(
    (response) =>
      response.request().postData()?.includes("pushDraftProcessExecution") ===
      true,
  )
  await page.getByRole("button", { name: "Save draft", exact: true }).click()
  expect(record(await (await saved).json())["errors"]).toBeUndefined()
  await page.goto("/processes")
  await page
    .getByRole("link", { name: "Continue", exact: true })
    .first()
    .click()
  await expect(
    page.getByRole("button", { name: "Submit", exact: true }),
  ).toBeVisible()
})

When(
  "I complete this onboarding execution in the browser",
  async ({ page, context, scenarioState }) => {
    test.setTimeout(240_000)
    const executionId = scenarioState.get("withoutWaitingExecution")
    assert.equal(typeof executionId, "string")
    const cookie = (await context.cookies()).find((cookie) =>
      cookie.name.startsWith("access_token"),
    )
    assert.ok(cookie)
    const read = async () => {
      const response = await page.request.post(getEffectiveGraphqlEndpoint(), {
        headers: { Authorization: `Bearer ${cookie.value}` },
        data: {
          query: `query { pullExecution(limit: 100) { documents { id status finishedAt withoutWaiting steps { id path name status } } } }`,
        },
      })
      const body = record(await response.json())
      expect(body["errors"]).toBeUndefined()
      const documents = record(record(body["data"])["pullExecution"])[
        "documents"
      ]
      assert.ok(Array.isArray(documents))
      const execution = documents
        .map(record)
        .find((item) => item["id"] === executionId)
      assert.ok(execution)
      return execution
    }
    for (const name of [
      "Create account",
      "Provision laptop",
      "Provide laptop and badge",
      "Orientation session",
      "Compliance training",
      "Review 30-60-90 day plan",
      "Day 30 check-in",
      "Formal performance review",
      "Passed",
      "Background check",
      "Assign desk",
      "Assign ID badge",
      "Onboarding checklist",
    ]) {
      let todo: Record<string, unknown> | undefined
      await expect(async () => {
        const steps = (await read())["steps"]
        assert.ok(Array.isArray(steps))
        todo = steps
          .map(record)
          .find(
            (step) =>
              String(step["path"]).endsWith(`/${name}`) &&
              step["status"] === "Waiting",
          )
        expect(todo).toBeDefined()
      }).toPass({ timeout: 30_000 })
      assert.ok(todo)
      await page.goto(
        `/to-dos/complete${String(todo["path"])}?todoId=${encodeURIComponent(String(todo["id"]))}`,
      )
      await expect(
        page.getByRole("button", { name: "Done", exact: true }),
      ).toBeVisible()
      if (name === "Formal performance review")
        await page.getByRole("checkbox").check()
      const response = page.waitForResponse(
        (response) =>
          response.request().postData()?.includes("mutation Complete(") ===
          true,
      )
      await page.getByRole("button", { name: "Done", exact: true }).click()
      expect(record(await (await response).json())["errors"]).toBeUndefined()
    }
    await expect(async () => {
      const execution = await read()
      expect(execution["status"]).toBe("Completed")
      expect(execution["finishedAt"]).toBeTruthy()
      expect(execution["withoutWaiting"]).toBe(true)
    }).toPass({ timeout: 30_000 })
    await page.goto("/executions")
    await page.getByRole("button", { name: /^Completed / }).click()
    await expect(
      page
        .getByRole("heading", {
          level: 4,
          name: "Onboard a new employee Without waiting",
          exact: true,
        })
        .first(),
    ).toBeVisible()
  },
)

Then(
  "the {string} grant shows process-specific submission controls",
  async ({ page }, grant: string) => {
    for (const [path, allowed] of [
      ["hr/on-boarding/Send%20welcome%20pack", true],
      ["hr/automation/scheduled-start/Start", true],
      [
        "hr/time-off-request/Submit%20time%20off%20request",
        grant !== "exact-process",
      ],
      ["finance/purchase-request/Submit%20request", grant === "broad"],
    ] as const) {
      await page.goto(`/processes/start/${path}`)
      await expect(
        page.getByRole("button", { name: "Submit", exact: true }),
      ).toBeVisible()
      const options = page.getByRole("button", { name: "Submission options" })
      await expect(options).toHaveCount(allowed ? 1 : 0)
      if (allowed) {
        await options.click()
        await expect(
          page.getByRole("menuitem", { name: "Submit without waiting" }),
        ).toBeVisible()
        await page.keyboard.press("Escape")
      }
    }
  },
)
