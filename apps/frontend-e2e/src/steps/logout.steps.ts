import type { Page } from "@playwright/test"
import { expect } from "@playwright/test"
import { Given, Then, When } from "./fixtures"

/**
 * Count RxDB keys in localStorage.
 * RxDB localStorage plugin uses keys starting with "RxDB-ls-".
 */
const getRxdbKeyCount = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      Object.keys(localStorage).filter((key) => key.startsWith("RxDB-ls-"))
        .length,
  )

/**
 * Compute cookie names matching the frontend's getCookieNamesFromHost().
 * On localhost, cookies are port-suffixed to avoid collisions between instances.
 */
const getAuthCookieNames = (): {
  accessToken: string
  refreshToken: string
} => {
  const baseUrl = new URL(process.env["BASE_URL"] ?? "http://localhost:3000")
  const isLocal =
    baseUrl.hostname === "localhost" || baseUrl.hostname === "127.0.0.1"
  const suffix = isLocal && baseUrl.port ? `_${baseUrl.port}` : ""
  return {
    accessToken: `access_token${suffix}`,
    refreshToken: `refresh_token${suffix}`,
  }
}

/**
 * Count authentication cookies in the browser context.
 */
const getAuthCookieCount = async (page: Page): Promise<number> => {
  const cookies = await page.context().cookies()
  const names = getAuthCookieNames()
  return cookies.filter(
    (c) => c.name === names.accessToken || c.name === names.refreshToken,
  ).length
}

Given("I wait for RxDB to populate local storage", async ({ page }) => {
  await expect
    .poll(() => getRxdbKeyCount(page), {
      message: "Waiting for RxDB to populate localStorage",
      timeout: 30_000,
    })
    .toBeGreaterThan(0)
})

When("I click the sidebar logout button", async ({ page }) => {
  const logoutButton = page.getByTestId("sidebar-logout-button")
  await logoutButton.click()
})

When("I open the profile dropdown", async ({ page }) => {
  const headerProfileButton = page.getByTestId("header-profile-button")
  await headerProfileButton.click()

  // Wait for dropdown to be visible
  await expect(
    page.locator('[data-slot="dropdown-menu-content"]'),
  ).toBeVisible()
})

When("I click the header logout button", async ({ page }) => {
  const logoutButton = page.getByTestId("header-logout-button")
  await logoutButton.click()
})

Then("all RxDB local storage should be cleared", async ({ page }) => {
  await expect
    .poll(() => getRxdbKeyCount(page), {
      message: "Waiting for RxDB localStorage to be cleared",
      timeout: 10000,
    })
    .toBe(0)
})

Then("all authentication cookies should be cleared", async ({ page }) => {
  await expect
    .poll(() => getAuthCookieCount(page), {
      message: "Waiting for auth cookies to be cleared",
      timeout: 5000,
    })
    .toBe(0)
})
