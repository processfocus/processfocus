import { expect } from "@playwright/test"
import { Then, When } from "./fixtures"

When("I visit the cloud org projects list", async ({ page }) => {
  await page.goto("/lists/projects", { waitUntil: "domcontentloaded" })
})

When(
  "I open the cloud org project named {string}",
  async ({ page }, projectName: string) => {
    const row = page.locator("tbody tr", { hasText: projectName }).first()
    await expect(row).toBeVisible({ timeout: 30_000 })
    await row.click()
  },
)

Then("I should see the project usage costs card", async ({ page }) => {
  await expect(
    page.getByText("Usage costs", { exact: true }).first(),
  ).toBeVisible({
    timeout: 30_000,
  })
})
