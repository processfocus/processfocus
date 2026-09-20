import { expect } from "@playwright/test"
import { Then, When } from "./fixtures"

When("I inspect the instant login shell", async ({ page, instantUI }) => {
  await instantUI(async () => {
    await page.goto("/login?error=not_authorized")
    await expect(
      page.getByRole("heading", { name: "Sign In", exact: true }),
    ).toBeVisible()
    await expect(page.getByText("Access Denied", { exact: true })).toHaveCount(
      0,
    )
  })
})

Then("the login error streams after the instant scope", async ({ page }) => {
  await expect(page.getByText("Access Denied", { exact: true })).toBeVisible()
})
