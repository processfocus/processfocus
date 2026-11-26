import { type Page, expect } from "@playwright/test"

/** Reusable normal login for SSO-only journeys; never injects auth state. */
export async function signInWithControlledProvider(
  page: Page,
  decision = "Continue as test user",
  destination = "/processes",
): Promise<void> {
  await page.goto(destination)
  await page.getByRole("button", { name: /Google/ }).click()
  await expect(
    page.getByRole("heading", { name: "Controlled Google provider" }),
  ).toBeVisible()
  await page.getByRole("button", { name: decision, exact: true }).click()
  await expect(page).toHaveURL((url) => url.pathname === destination, {
    timeout: 30_000,
  })
  if (destination === "/processes")
    await expect(
      page.getByRole("heading", { name: "Processes", exact: true }),
    ).toBeVisible()
}
