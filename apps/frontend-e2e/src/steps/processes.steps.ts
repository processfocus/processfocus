import { expect } from "@playwright/test"
import { Given, Then, When } from "./fixtures"

Given("I am using a mobile viewport", async ({ page }) => {
  // iPhone 14 viewport
  await page.setViewportSize({ width: 390, height: 844 })
})

Then(
  "I should see the {string} process",
  async ({ page }, processName: string) => {
    const heading = page.getByRole("heading", {
      name: processName,
      exact: true,
    })
    await expect(heading).toBeVisible({ timeout: 15000 })
  },
)

Then("I should see the mobile processes catalog", async ({ page }) => {
  await expect(
    page.getByRole("heading", { name: "Processes", exact: true }),
  ).toBeVisible({ timeout: 15000 })
  // Mobile view shows links with accessible names like "Start Purchase Request"
  await expect(page.getByRole("link", { name: /^Start/ }).first()).toBeVisible({
    timeout: 15000,
  })
})

When(
  "I open the {string} process from the mobile catalog row",
  async ({ page }, processName: string) => {
    const processCard = page
      .locator("article", {
        has: page.getByRole("heading", { name: processName, exact: true }),
      })
      .first()
    // Click the visible "Start" link with the process name (not the invisible row link)
    await processCard
      .getByRole("link", { name: new RegExp(`^Start ${processName}$`) })
      .click()
  },
)

When(
  "I start the {string} process from the mobile catalog action",
  async ({ page }, processName: string) => {
    const processRow = page
      .locator("article", {
        has: page.getByRole("heading", { name: processName, exact: true }),
      })
      .first()
    // Mobile view shows links with accessible names like "Start Purchase Request"
    await processRow
      .getByRole("link", { name: new RegExp(`^Start ${processName}$`) })
      .click()
  },
)

Then("I should be on a process start page", async ({ page }) => {
  await expect(page).toHaveURL(/\/processes\/start\//, { timeout: 15000 })
})
