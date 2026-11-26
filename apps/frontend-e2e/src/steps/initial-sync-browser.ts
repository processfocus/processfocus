import type { Page } from "@playwright/test"
import { expect } from "@playwright/test"

export const signInThroughDummy = async (page: Page, path: string) => {
  await page.context().clearCookies()
  await page.goto(`/login?redirect=${path}`, { waitUntil: "domcontentloaded" })
  await page.waitForLoadState("networkidle")
  await page.getByRole("button", { name: "Sign in with dummy" }).click()
  await expect(page).toHaveURL((url) => url.pathname === path, {
    timeout: 30_000,
  })
}

export const switchDashboardRole = async (page: Page, role: string) => {
  const previousDocument = await page.evaluate(() => performance.timeOrigin)
  const path = new URL(page.url()).pathname
  await page.getByTestId("header-profile-button").click()
  await page.getByRole("menuitem", { name: "Switch Role", exact: true }).hover()
  const navigation = page.waitForEvent("framenavigated", {
    predicate: (frame) =>
      frame === page.mainFrame() && new URL(frame.url()).pathname === path,
  })
  await page.getByRole("menuitem", { name: role, exact: true }).click()
  await navigation
  await page.waitForLoadState("domcontentloaded")
  expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(
    previousDocument,
  )
  await expect(page).toHaveURL((url) => url.pathname === path)
}
