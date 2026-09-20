import { expect } from "@playwright/test"
import { Then, When } from "./fixtures"

const LIST_TIMEOUT = 30_000

When("I visit the process catalog browsing list", async ({ page }) => {
  await page.goto("/lists/process-catalog-browsing", {
    waitUntil: "domcontentloaded",
  })
})

Then(
  "I should see process catalog list data for {string}",
  async ({ page }, processName: string) => {
    await expect(
      page.getByRole("heading", {
        name: "Process Catalog Browsing",
        exact: true,
      }),
    ).toBeVisible({ timeout: 15_000 })

    const row = page.locator("tbody tr", { hasText: processName }).first()
    await expect(row).toBeVisible({ timeout: LIST_TIMEOUT })
    await expect(row).toContainText("/purchase-request")
  },
)

When(
  "I sort the process catalog browsing list by {string}",
  async ({ page }, columnName: string) => {
    await page
      .getByRole("button", { name: new RegExp(`^${columnName}\\b`) })
      .click()
  },
)
