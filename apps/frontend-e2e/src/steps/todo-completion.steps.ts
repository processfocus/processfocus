import { randomUUID } from "node:crypto"
import type { Page, Request, Response } from "@playwright/test"
import { expect } from "@playwright/test"
import { Given, Then, When, appDialog } from "./fixtures"

const completionName = "completeFinancePurchaseRequestManagerApproval"
const inputType = "FinancePurchaseRequestManagerApproval"

class CompletionJourney {
  readonly item = `E2E approval ${randomUUID()}`
  readonly cost = "750"
  readonly warnings: string[] = []
  readonly completions: Request[] = []
  todoId = ""
  metadata: unknown
  response: Response | undefined
}

const journeyFor = (state: Map<string, unknown>) => {
  const journey = state.get("completionJourney")
  if (!(journey instanceof CompletionJourney)) {
    throw new Error("Completion observation must start before navigation")
  }
  return journey
}

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a JSON object")
  }
  return Object.fromEntries(Object.entries(value))
}

const requestBody = (request: Request) =>
  record(JSON.parse(request.postData() ?? "{}"))

const isCompletion = (request: Request) =>
  request.method() === "POST" &&
  request.postData()?.includes(completionName) === true

const approvalCard = ({
  page,
  journey,
}: {
  page: Page
  journey: CompletionJourney
}) =>
  page
    .locator("article", {
      has: page.getByRole("heading", {
        name: "Approve purchase request",
        exact: true,
      }),
    })
    .filter({ hasText: `${journey.item} for ${journey.cost}` })

Given(
  "I observe the authenticated completion journey",
  async ({ page, scenarioState }) => {
    const journey = new CompletionJourney()
    scenarioState.set("completionJourney", journey)
    page.on("console", (message) => {
      if (message.type() === "warning" || message.type() === "error") {
        journey.warnings.push(message.text())
      }
    })
    page.on("request", (request) => {
      if (isCompletion(request)) journey.completions.push(request)
    })
  },
)

When(
  "I fill the purchase request with a scenario-unique item and cost",
  async ({ page, scenarioState }) => {
    const journey = journeyFor(scenarioState)
    const dialog = appDialog(page)
    await dialog
      .getByRole("group")
      .filter({ hasText: "Item" })
      .locator("input")
      .fill(journey.item)
    await dialog
      .getByRole("group")
      .filter({ hasText: "Value" })
      .locator("input")
      .fill(journey.cost)
  },
)

When(
  "I open the uniquely created approval todo",
  async ({ page, scenarioState }) => {
    const journey = journeyFor(scenarioState)
    const card = approvalCard({ page, journey })
    // This journey covers persisted completion, independently of live subscriptions.
    // Refresh the visible queue while the runtime creates the next step's todo.
    await expect(async () => {
      const [replication] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().postData()?.includes("query PullTodo(") === true,
        ),
        page.reload({ waitUntil: "domcontentloaded" }),
      ])
      expect(replication.ok()).toBe(true)
      expect(record(await replication.json())["errors"]).toBeUndefined()
      await expect(
        page.getByRole("button", { name: "Comfortable", exact: true }),
      ).toBeVisible()
      // The existing local queue can render before the latest pull is applied.
      await expect(card).toHaveCount(1, { timeout: 5_000 })
    }).toPass({ timeout: 60_000 })
    const action = card.getByRole("link", { name: "Do", exact: true })
    const href = await action.getAttribute("href")
    expect(href).toBeTruthy()
    journey.todoId =
      new URL(href ?? "", page.url()).searchParams.get("todoId") ?? ""
    expect(journey.todoId).not.toBe("")
    const metadataResponse = page.waitForResponse((response) => {
      const request = response.request()
      return (
        request.method() === "POST" &&
        request.postData()?.includes("query FormMetadata") === true &&
        record(requestBody(request)["variables"])["todoId"] === journey.todoId
      )
    })
    await action.click()
    const response = await metadataResponse
    expect(response.ok()).toBe(true)
    const body = record(await response.json())
    expect(body["errors"]).toBeUndefined()
    journey.metadata = record(body["data"])["formMetadata"]
  },
)

Then(
  "the approval form and real metadata contain the state-aware fields",
  async ({ page, scenarioState }) => {
    const journey = journeyFor(scenarioState)
    const metadata = record(journey.metadata)
    expect(metadata).toMatchObject({
      inputTypeName: inputType,
      completeMutationName: completionName,
    })
    const components = record(record(metadata["formDefinition"])["components"])
    expect(components["check"]).toMatchObject({
      _tag: "boolean",
      field: "check",
      required: true,
    })
    expect(metadata["jsonSchema"]).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["check"]),
      properties: { check: { type: "boolean" } },
    })
    for (const { label, value } of [
      { label: "Item to approve", value: journey.item },
      { label: "Cost", value: journey.cost },
    ]) {
      const field = page
        .getByRole("group")
        .filter({ hasText: label })
        .locator("input")
      await expect(field).toHaveValue(value)
      await expect(field).toHaveAttribute("readonly", "")
    }
    await expect(
      page.getByRole("checkbox", { name: "I approve" }),
    ).not.toBeChecked()
  },
)

When(
  "I view the approval in a {string} form",
  async ({ page }, surface: string) => {
    await expect(appDialog(page)).toBeVisible()
    if (surface === "full-page") {
      // Reload opens the full-page route without adding a duplicate history entry.
      await page.reload()
      await expect(appDialog(page)).toHaveCount(0)
    } else {
      expect(surface).toBe("modal")
    }
  },
)

When(
  "my unsaved approval survives back and forward in the {string} form",
  async ({ page, scenarioState }, surface: string) => {
    const destination = page.url()
    const approval = page.getByRole("checkbox", { name: "I approve" })
    await approval.check()
    const draftKey = `todo-complete-${journeyFor(scenarioState).todoId}`
    await expect
      .poll(() => page.evaluate((key) => localStorage.getItem(key), draftKey))
      .toContain('"check":true')
    await page.goBack()
    await expect(page).toHaveURL(/\/to-dos$/)
    await expect(appDialog(page)).toBeHidden()
    await page.goForward()
    await expect(page).toHaveURL(destination)
    await expect(approval).toBeChecked()
    if (surface === "full-page") {
      await expect(appDialog(page)).toHaveCount(0)
    } else {
      await expect(appDialog(page)).toBeVisible()
    }
  },
)

When("I submit the approval without checking I approve", async ({ page }) => {
  await page.getByRole("button", { name: "Done", exact: true }).click()
})

Then(
  "approval validation prevents a completion mutation",
  async ({ page, scenarioState }) => {
    await expect(
      page.getByText("This field is required.", { exact: true }),
    ).toBeVisible()
    expect(journeyFor(scenarioState).completions).toHaveLength(0)
  },
)

When(
  "I check I approve and complete the todo",
  async ({ page, scenarioState }) => {
    const journey = journeyFor(scenarioState)
    await page.getByRole("checkbox", { name: "I approve" }).check()
    const completionResponse = page.waitForResponse((response) =>
      isCompletion(response.request()),
    )
    await page.getByRole("button", { name: "Done", exact: true }).click()
    journey.response = await completionResponse
  },
)

Then("the generated approval mutation succeeds", async ({ scenarioState }) => {
  const journey = journeyFor(scenarioState)
  expect(journey.completions).toHaveLength(1)
  const response = journey.response
  if (!response) throw new Error("No completion response observed")
  const body = requestBody(response.request())
  expect(body["query"]).toContain(`$input: ${inputType}!`)
  expect(body["variables"]).toEqual({
    todoId: journey.todoId,
    input: { check: true },
  })
  expect(response.ok()).toBe(true)
  const result = record(await response.json())
  expect(result["errors"]).toBeUndefined()
  expect(record(result["data"])[completionName]).toMatchObject({
    executionId: expect.any(String),
    stepPath: "/finance/purchase-request/Manager approval",
    timestamp: expect.any(String),
  })
})

Then(
  "the created approval remains absent after a hard refresh",
  async ({ page, scenarioState }) => {
    const journey = journeyFor(scenarioState)
    await expect(
      page.getByRole("button", { name: "Done", exact: true }),
    ).toHaveCount(0)
    await expect(page).toHaveURL(/\/to-dos$/)
    await page.goto("/to-dos", { waitUntil: "domcontentloaded" })
    await expect(
      page.getByRole("button", { name: "Comfortable", exact: true }),
    ).toBeVisible()
    await expect(approvalCard({ page, journey })).toHaveCount(0, {
      timeout: 30_000,
    })
    const replicated = page.waitForResponse(
      (response) =>
        response.request().postData()?.includes("query PullTodo(") === true,
    )
    await page.reload({ waitUntil: "domcontentloaded" })
    const replication = await replicated
    expect(replication.ok()).toBe(true)
    expect(record(await replication.json())["errors"]).toBeUndefined()
    // This control is rendered only once the todo query is ready.
    await expect(
      page.getByRole("button", { name: "Comfortable", exact: true }),
    ).toBeVisible()
    await expect(approvalCard({ page, journey })).toHaveCount(0, {
      timeout: 30_000,
    })
  },
)

Then("the browser has no AJV schema warnings", async ({ scenarioState }) => {
  expect(
    journeyFor(scenarioState).warnings.filter((warning) =>
      /missing type ["']object["']|\/schemas\/%7B%7D#/i.test(warning),
    ),
  ).toEqual([])
})
