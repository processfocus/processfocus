import type { Page } from "@playwright/test"
import { expect } from "@playwright/test"
import { Then, When } from "./fixtures"

const EXECUTION_TIMEOUT = 30_000

const getExecutionCard = (page: Page, name: string) =>
  page
    .locator("article", {
      has: page.getByRole("heading", { name, exact: true }),
    })
    .first()

const getExecutionTimelineStep = (page: Page, name: string) =>
  page.getByRole("listitem").filter({
    has: page.getByText(name, { exact: true }),
  })

Then(
  "the {string} execution timestamps should cycle independently without opening it",
  async ({ page }, processName: string) => {
    const card = getExecutionCard(page, processName)
    const times = card.locator("button:has(time)")
    await expect(times).toHaveCount(2)
    const first = times.first()
    const sibling = times.last()
    const siblingLabel = await sibling.getAttribute("aria-label")
    const url = page.url()
    await expect(first).toHaveAccessibleName(/\. Relative time\. Show/)
    await first.press("Enter")
    await expect(first).toHaveAccessibleName(/\. Browser-local time\. Show/)
    await expect(sibling).toHaveAttribute("aria-label", siblingLabel ?? "")
    await expect(page).toHaveURL(url)
    const hasUtcMode = (await first.getAttribute("aria-label"))?.endsWith(
      "Show UTC.",
    )
    await first.click()
    await expect(first).toHaveAccessibleName(
      hasUtcMode ? /\. UTC\. Show/ : /\. Relative time\. Show/,
    )
    await expect(page).toHaveURL(url)
  },
)

When("I visit the executions page", async ({ page }) => {
  await page.goto("/executions", { waitUntil: "domcontentloaded" })
})

When(
  "I filter executions by {string}",
  async ({ page }, filterName: string) => {
    await page
      .getByRole("button", { name: new RegExp(`^${filterName}\\b`) })
      .click()
  },
)

When(
  "I open the {string} execution from the executions list",
  async ({ page }, processName: string) => {
    await getExecutionCard(page, processName)
      .getByRole("button", { name: processName, exact: true })
      .click()
  },
)

Then(
  "I should see execution browsing for {string}",
  async ({ page }, processName: string) => {
    await expect(getExecutionCard(page, processName)).toBeVisible({
      timeout: EXECUTION_TIMEOUT,
    })
    await expect(
      page.getByText("Running", { exact: true }).first(),
    ).toBeVisible()
  },
)

Then(
  "I should see execution detail for {string}",
  async ({ page }, processName: string) => {
    await expect(page).toHaveURL(/\/executions\//, {
      timeout: EXECUTION_TIMEOUT,
    })
    await expect(
      page.getByRole("heading", { name: processName, exact: true }).last(),
    ).toBeVisible({ timeout: EXECUTION_TIMEOUT })
    await expect(page.getByText("Timeline", { exact: true })).toBeVisible()
    await expect(
      getExecutionTimelineStep(page, "Approve purchase request"),
    ).toBeVisible({ timeout: EXECUTION_TIMEOUT })
  },
)

Then(
  "I should see process workflow information for {string}",
  async ({ page }, processName: string) => {
    await expect(
      page.getByRole("link", {
        name: `View workflow information for ${processName}`,
      }),
    ).toBeVisible()
  },
)

When(
  "I view process workflow information for {string}",
  async ({ page }, processName: string) => {
    await page
      .getByRole("link", {
        name: `View workflow information for ${processName}`,
      })
      .click()
  },
)

Then(
  "I should see the {string} workflow diagram",
  async ({ page }, processName: string) => {
    await expect(page).toHaveURL(/\/processes\/workflow\//, {
      timeout: EXECUTION_TIMEOUT,
    })
    await expect(
      page.getByRole("heading", { name: processName, exact: true }),
    ).toBeVisible({ timeout: EXECUTION_TIMEOUT })
    await expect(
      page.getByRole("region", { name: "Workflow diagram" }),
    ).toBeVisible({ timeout: EXECUTION_TIMEOUT })
  },
)
