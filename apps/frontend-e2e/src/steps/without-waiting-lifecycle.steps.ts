import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect } from "@playwright/test"
import { createBdd } from "playwright-bdd"
import {
  getEffectiveAuthUrl,
  getEffectiveGraphqlEndpoint,
} from "@pf/frontend-endpoints/port-files"
import { Given, Then, When, test } from "./fixtures"

const { After } = createBdd(test)
After(async ({ scenarioState }) => {
  const dir = scenarioState.get("lifecycleControlDirectory")
  if (typeof dir === "string") await rm(dir, { recursive: true, force: true })
})

const record = (value: unknown): Record<string, unknown> => {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  )
  return Object.fromEntries(Object.entries(value))
}
const query = async (
  token: string,
  document: string,
  variables?: Record<string, unknown>,
) => {
  const response = await fetch(getEffectiveGraphqlEndpoint(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query: document, variables }),
  })
  const body = record(await response.json())
  expect(body["errors"]).toBeUndefined()
  return record(body["data"])
}
const token = async (scope?: string): Promise<string> => {
  const response = await fetch(`${getEffectiveAuthUrl()}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`ci-pipeline:${process.env["CI_PIPELINE_SECRET"] ?? "ci-pipeline-secret"}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      ...(scope ? { scope } : {}),
    }),
  })
  const value = record(await response.json())["access_token"]
  assert.ok(typeof value === "string")
  return value
}
const saved = (state: Map<string, unknown>, key: string): string => {
  const value = state.get(key)
  assert.ok(typeof value === "string")
  return value
}
const execution = async (state: Map<string, unknown>) => {
  const data = await query(
    saved(state, "lifecycleToken"),
    `query { pullExecution(limit:100) { documents { id withoutWaiting status startedAt steps { id path status failureReason } } } }`,
  )
  const rows = record(data["pullExecution"])["documents"]
  assert.ok(Array.isArray(rows))
  const row = rows.map(record).find((r) => r["id"] === state.get("lifecycleId"))
  assert.ok(row)
  return row
}

Given(
  "a disposable Without Waiting execution has failed automated work",
  async ({ baseURL, scenarioState }) => {
    test.setTimeout(120_000)
    assert.ok(baseURL && new URL(baseURL).hostname === "localhost")
    const sa = await token()
    await query(
      sa,
      `mutation { requestRole(rolePath:"/Employee") { success } }`,
    )
    const employee = await token("role:/Employee")
    scenarioState.set("lifecycleToken", employee)
    const dir = await mkdtemp(join(tmpdir(), "pf-browser-lifecycle-"))
    scenarioState.set("lifecycleControlDirectory", dir)
    const control = join(dir, "control")
    await writeFile(control, "terminal")
    scenarioState.set("lifecycleControl", control)
    const started = await query(
      employee,
      `mutation($control:String!) { startLifecycle(input:{control:$control},withoutWaiting:true) { executionId } }`,
      { control },
    )
    scenarioState.set(
      "lifecycleId",
      record(started["startLifecycle"])["executionId"],
    )
    await expect
      .poll(async () => (await execution(scenarioState))["status"], {
        timeout: 30_000,
      })
      .toBe("Failed")
    scenarioState.set(
      "lifecycleStartedAt",
      (await execution(scenarioState))["startedAt"],
    )
  },
)
When(
  "I view the failed Without Waiting execution",
  async ({ page, scenarioState }) => {
    await page.goto("/executions?filter=all")
    await page
      .getByRole("button", { name: /^Lifecycle recovery Without waiting/ })
      .first()
      .click()
    await page.waitForURL(
      (url) =>
        url.pathname === `/executions/${saved(scenarioState, "lifecycleId")}`,
    )
  },
)
Then("I see its mode and failure evidence", async ({ page }) => {
  await expect(
    page.getByRole("heading", {
      level: 3,
      name: "Lifecycle recovery Without waiting",
      exact: true,
    }),
  ).toBeVisible()
  await expect(
    page
      .getByText("Configured lifecycle action failure", { exact: false })
      .first(),
  ).toBeVisible()
  const dir = process.env["PF_LIFECYCLE_ARTIFACTS_DIR"]
  if (dir) {
    await mkdir(dir, { recursive: true })
    await page.screenshot({
      path: join(dir, "after-participant-failed.png"),
      fullPage: true,
    })
  }
})
When(
  "I repair the action and restart the execution in the browser",
  async ({ page, scenarioState }) => {
    await writeFile(saved(scenarioState, "lifecycleControl"), "success")
    await page
      .getByRole("button", { name: "Open menu", exact: true })
      .first()
      .click()
    const response = page.waitForResponse(
      (r) => r.request().postData()?.includes("restartExecution") === true,
    )
    await page
      .getByRole("menuitem", { name: "Restart execution", exact: true })
      .click()
    const result = record(await (await response).json())
    expect(result["errors"]).toBeUndefined()
    expect(record(record(result["data"])["restartExecution"])["success"]).toBe(
      true,
    )
  },
)
Then(
  "the same execution retains its badge and scheduled work becomes ready",
  async ({ page, scenarioState }) => {
    await expect
      .poll(
        async () => {
          const row = await execution(scenarioState)
          expect(row["withoutWaiting"]).toBe(true)
          expect(row["startedAt"]).toBe(scenarioState.get("lifecycleStartedAt"))
          const steps = row["steps"]
          assert.ok(Array.isArray(steps))
          return steps
            .map(record)
            .find((s) => s["path"] === "/lifecycle/Gate")?.["status"]
        },
        { timeout: 30_000 },
      )
      .toBe("Waiting")
    await expect(page.getByText("Gate", { exact: true }).last()).toBeVisible({
      timeout: 30_000,
    })
    await page.reload()
    await expect(
      page.getByRole("heading", {
        level: 3,
        name: "Lifecycle recovery Without waiting",
        exact: true,
      }),
    ).toBeVisible()
    await expect(page.getByText("Gate", { exact: true }).last()).toBeVisible()
    const journal = await readFile(
      `${saved(scenarioState, "lifecycleControl")}.attempts`,
      "utf8",
    )
    expect(journal.trim().split("\n")).toHaveLength(2)
    const dir = process.env["PF_LIFECYCLE_ARTIFACTS_DIR"]
    if (dir)
      await page.screenshot({
        path: join(dir, "after-participant-recovered.png"),
        fullPage: true,
      })
  },
)
When("I open the lifecycle start form", async ({ page }) => {
  await page.goto("/processes/start/lifecycle/Submit")
  await expect(
    page.getByRole("button", { name: "Submit", exact: true }),
  ).toBeVisible()
})
