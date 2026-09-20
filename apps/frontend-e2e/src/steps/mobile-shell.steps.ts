import { expect } from "@playwright/test"
import { Given, Then, When } from "./fixtures"

const parseCount = (value: string | null): number => {
  if (!value) return 0

  const match = value.match(/(\d+)/)
  if (!match?.[1]) return 0

  const count = Number.parseInt(match[1], 10)
  return Number.isNaN(count) ? 0 : count
}

Given("I use a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 851 })
})

When("I open the mobile navigation drawer", async ({ page }) => {
  const toggleButton = page.getByRole("button", { name: "Toggle Sidebar" })
  await expect(toggleButton).toBeVisible()
  await toggleButton.click()
  await expect(page.getByTestId("mobile-sidebar")).toBeVisible()
})

When(
  "I navigate to the {string} page from the mobile navigation drawer",
  async ({ page }, pageName: string) => {
    const destination =
      pageName === "Processes" ? /\/processes$/ : new RegExp(pageName, "i")

    await Promise.all([
      page.waitForURL(destination),
      page
        .getByTestId("mobile-sidebar")
        .getByRole("link", { name: pageName })
        .click(),
    ])
  },
)

Then(
  "I should see the mobile header title {string}",
  async ({ page }, title) => {
    await expect(page.getByTestId("header-title")).toHaveText(title)
  },
)

Then("I should not see a mobile header subtitle", async ({ page }) => {
  await expect(page.getByTestId("header-subtitle")).toHaveCount(0)
})

Then("I should not see the mobile header theme toggle", async ({ page }) => {
  await expect(page.getByTestId("header-theme-toggle")).toHaveCount(0)
})

Then("the mobile navigation drawer should be closed", async ({ page }) => {
  await expect(page.getByTestId("mobile-sidebar")).toHaveCount(0)
})

Then(
  "I should see the mobile home action card {string}",
  async ({ page }, cardTitle: string) => {
    await expect(
      page.getByTestId("mobile-home-switchboard").getByRole("heading", {
        name: cardTitle,
      }),
    ).toBeVisible()
  },
)

Then(
  "the mobile home open-task count should match the sidebar todo count",
  async ({ page }) => {
    const homeCount = parseCount(
      await page.getByTestId("mobile-home-open-task-count").textContent(),
    )

    const toggleButton = page.getByRole("button", { name: "Toggle Sidebar" })
    await expect(toggleButton).toBeVisible()
    await toggleButton.click()
    const todoLink = page
      .getByTestId("mobile-sidebar")
      .locator('a[href="/to-dos"]')
    await expect(todoLink).toBeVisible()
    await expect
      .poll(async () => parseCount(await todoLink.textContent()), {
        message: "Waiting for sidebar todo count to match mobile home",
      })
      .toBe(homeCount)
  },
)

Then(
  "the mobile start process card should not show a process count",
  async ({ page }) => {
    await expect(
      page.getByTestId("mobile-home-start-process-card"),
    ).not.toContainText(/\b\d+\s+process/i)
  },
)
