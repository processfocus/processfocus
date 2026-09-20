import { expect } from "@playwright/test"
import { Then, When } from "./fixtures"

const DATA_TIMEOUT = 15_000

const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

When("I visit the settings page", async ({ page }) => {
  await page.goto("/settings")
})

When(
  "I open the {string} settings table",
  async ({ page }, tableName: string) => {
    await page
      .getByRole("button", {
        name: new RegExp(`^${escapeRegex(tableName)}\\b`),
      })
      .click()
  },
)

Then("I should see settings users table data", async ({ page }) => {
  await expect(
    page.getByRole("heading", {
      level: 2,
      name: "Profile & Settings",
      exact: true,
    }),
  ).toBeVisible({ timeout: DATA_TIMEOUT })
  await expect(page.getByRole("columnheader", { name: "Email" })).toBeVisible()
  await expect(
    page.getByRole("cell", { exact: true, name: "ci@example.com" }),
  ).toBeVisible({
    timeout: DATA_TIMEOUT,
  })
})

Then("I should see settings roles table data", async ({ page }) => {
  await expect(
    page.getByRole("columnheader", { name: "Role Name" }),
  ).toBeVisible()
  await expect(
    page.getByRole("cell", { exact: true, name: "Administrator" }),
  ).toBeVisible({ timeout: DATA_TIMEOUT })
})

Then("I should see settings invitations table data", async ({ page }) => {
  await expect(
    page.getByRole("heading", {
      exact: true,
      level: 2,
      name: "Invited Users",
    }),
  ).toBeVisible()
  await expect(page.getByRole("columnheader", { name: "Roles" })).toBeVisible()
  await expect(page.getByRole("columnheader", { name: "Status" })).toBeVisible()
  // Default filter is pending. Use the dedicated settings-e2e invitation which
  // no E2E suite authenticates as, so it stays pending after the lifecycle
  // migration. Other invitation emails (ci@example.com, employee@example.com,
  // etc.) have matching provider users from prior runs and are legacy-closed.
  await expect(
    page.getByRole("cell", { name: "settings-e2e@example.com" }),
  ).toBeVisible({
    timeout: DATA_TIMEOUT,
  })
})

Then("I should see settings providers table data", async ({ page }) => {
  await expect(
    page.getByRole("columnheader", { name: "Provider Name" }),
  ).toBeVisible()
  await expect(page.getByRole("cell", { name: /google/i })).toBeVisible({
    timeout: DATA_TIMEOUT,
  })
})

When(
  "I open the settings user row for {string}",
  async ({ page }, email: string) => {
    await page.getByRole("cell", { exact: true, name: email }).click()
  },
)

Then(
  "I should see the settings user detail for {string}",
  async ({ page }, email: string) => {
    await expect(page).toHaveURL(/\/settings\/users\//, {
      timeout: DATA_TIMEOUT,
    })
    await expect(
      page.getByRole("heading", { name: "Edit Provider User" }),
    ).toBeVisible()
    await expect(page.getByRole("textbox", { name: "Email" })).toHaveValue(
      email,
    )
  },
)
