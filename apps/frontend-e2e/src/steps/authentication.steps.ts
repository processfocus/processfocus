import { expect } from "@playwright/test"
import { Given, Then, When } from "./fixtures"

Given("I am not logged in", async ({ page }) => {
  // Clear any existing session/cookies to ensure we're not logged in
  await page.context().clearCookies()
})

Given(
  "I am authenticated as provider user {string}",
  async ({ authenticateAsProviderUser }, email: string) => {
    // Authenticate as the specified provider user via M2M client_credentials grant
    await authenticateAsProviderUser(email)
  },
)

When("I visit the home page", async ({ page }) => {
  await page.goto("/")
})

When("I visit the processes page", async ({ page }) => {
  await page.goto("/processes")
})

When("I visit the passkey registration page", async ({ page }) => {
  await page.goto("/register/passkey")
})

// Use 10s timeout to make our logout.feature less fragile
Then("I should be redirected to the login page", async ({ page }) => {
  await expect(page).toHaveURL(/\/login/, { timeout: 10000 })
})

Then("I should stay on the passkey registration page", async ({ page }) => {
  await expect(page).toHaveURL(/\/register\/passkey/, { timeout: 10_000 })
  await expect(page).not.toHaveURL(/\/login/)
})

Then("I should see that registration is unavailable", async ({ page }) => {
  await expect(
    page.getByRole("heading", { name: "Registration unavailable" }),
  ).toBeVisible({ timeout: 10_000 })
  await expect(
    page.getByText(
      "This registration link is no longer valid. Ask an administrator for a new Registration Link.",
    ),
  ).toBeVisible()
})

Then("the login URL should not have a redirect parameter", async ({ page }) => {
  const url = new URL(page.url())
  expect(url.searchParams.has("redirect")).toBe(false)
})

Then(
  "the login URL should have a redirect parameter for {string}",
  async ({ page }, expectedPath: string) => {
    const url = new URL(page.url())
    const redirectParam = url.searchParams.get("redirect")
    expect(redirectParam).toBe(expectedPath)
  },
)

Then("I should see the home page", async ({ page }) => {
  await expect(page).not.toHaveURL(/\/login/)
  await expect(page).toHaveURL("/")
})

Then(
  "I should see the organisation name {string}",
  async ({ page }, orgName: string) => {
    const orgNameElement = page.getByTestId("org-name")
    await expect(orgNameElement).toHaveText(orgName, { timeout: 15_000 })
  },
)

Then("I should see the desktop dashboard summary", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Throughput" })).toBeVisible({
    timeout: 15_000,
  })
  await expect(
    page.getByText("Weekly completions", { exact: true }),
  ).toBeVisible()
  await expect(page.getByText("SLA compliance", { exact: true })).toBeVisible()
  await expect(page.getByText("Open tasks", { exact: true })).toBeVisible()
})

Then("I should not see a visible error boundary", async ({ page }) => {
  await expect(page.getByText("Something went wrong")).toHaveCount(0)
  await expect(page.getByText("Application error")).toHaveCount(0)
})
