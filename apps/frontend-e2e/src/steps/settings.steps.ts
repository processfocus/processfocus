import { type Page, type Request, expect } from "@playwright/test"
import { parse, visit } from "graphql"
import { Given, Then, When, test } from "./fixtures"

const DATA_TIMEOUT = 15_000

async function findSettingsCell(page: Page, name: string) {
  const cell = page
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name, exact: true }) })
  await expect(page.getByRole("row").nth(1)).toBeVisible({
    timeout: DATA_TIMEOUT,
  })
  const next = page.getByRole("button", { name: "Next", exact: true })
  while (
    !(await cell.isVisible()) &&
    (await next.count()) > 0 &&
    (await next.isEnabled())
  ) {
    const firstRow = page.getByRole("row").nth(1)
    const previousRow = await firstRow.textContent()
    await next.click()
    await expect(firstRow).not.toHaveText(previousRow ?? "", {
      timeout: DATA_TIMEOUT,
    })
  }
  await expect(cell).toBeVisible({ timeout: DATA_TIMEOUT })
  return cell
}

When("I explore public-link completion in Cedar", async ({ page }) => {
  await page.goto("/settings/cedar/explorer")
  await page
    .getByRole("combobox", { name: "Principal", exact: true })
    .selectOption("public-link")
  await page
    .getByRole("combobox", { name: "Action", exact: true })
    .selectOption("complete")
  await expect(page.getByRole("combobox", { name: /^Resource\b/ })).toHaveValue(
    "PF::Step",
  )
  await expect(page.getByLabel("Todo ID", { exact: true })).toHaveValue("")
})

When(
  "I set the Cedar completion Todo ID to {string}",
  async ({ page }, todoId: string) => {
    await page.getByLabel("Todo ID", { exact: true }).fill(todoId)
    await expect(page.locator("pre").last()).toContainText(
      `"todoId": "${todoId}"`,
      { timeout: DATA_TIMEOUT },
    )
  },
)

Then(
  "the Cedar explorer should {word} completion",
  async ({ page }, decision: string) => {
    // Next.js queues Server Actions, including evaluations for earlier inputs.
    await expect(page.getByText(decision, { exact: true })).toBeVisible({
      timeout: DATA_TIMEOUT,
    })
    await expect(page.locator("pre").last()).toContainText('"errors": []')
  },
)

const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

When("I warm the Cedar route using the schema page", async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto("/settings/cedar/schema")
  // Exclude development compilation from the CPU-budget measurement, while
  // proving the real backend delivered the intended large policy fixture.
  await page.getByRole("link", { name: "Policies", exact: true }).click()
  await expect(
    page.getByText(/cedar-scale-4095@example\.test/).first(),
  ).toBeVisible({ timeout: 60_000 })
})

Then(
  "the Cedar access handbook should load within the hosted request budget",
  async ({ page }) => {
    const budget = 20_000
    const started = performance.now()
    const response = await page.goto("/settings/cedar/access", {
      timeout: budget,
    })
    expect(response?.status()).toBe(200)
    await expect(
      page.getByRole("article").getByText("Sign in", { exact: true }),
    ).toBeVisible({
      timeout: Math.max(1, budget - (performance.now() - started)),
    })
    const elapsed = performance.now() - started
    test.info().annotations.push({
      type: "handbook-duration-ms",
      description: String(Math.round(elapsed)),
    })
    expect(elapsed).toBeLessThan(budget)
  },
)

When(
  "I visit the Cedar access page at {string}",
  async ({ page }, path: string) => {
    const response = await page.goto(path)
    expect(response?.status()).toBe(200)
  },
)

Then("I should see the Cedar access handbook", async ({ page }) => {
  const handbook = page.getByRole("article")
  await expect(
    handbook.getByText("How access works here", { exact: true }),
  ).toBeVisible({ timeout: DATA_TIMEOUT })
  await expect(
    handbook.getByRole("heading", { name: "Pick a principal", exact: true }),
  ).toHaveCount(0)
  await expect(
    handbook.getByRole("heading", { name: "Sign-in", exact: true }),
  ).toBeVisible()
  await expect(handbook.getByText("Sign in", { exact: true })).toBeVisible()
})

When(
  "I select the Cedar principal {string}",
  async ({ page }, principal: string) => {
    await page.getByRole("button", { name: principal, exact: true }).click()
  },
)

Then(
  "I should see the Cedar principal heading {string}",
  async ({ page }, principal: string) => {
    await expect(
      page
        .getByRole("article")
        .getByRole("heading", { name: principal, exact: true }),
    ).toBeVisible()
  },
)

When("I visit the settings page", async ({ page }) => {
  await page.goto("/settings")
})

When(
  "I visit the settings section at {string}",
  async ({ page }, path: string) => {
    await page.goto(path)
  },
)

When("I reload the settings section", async ({ page }) => {
  await page.reload()
})

When(
  "I open the settings section in a new tab showing {string}",
  async ({ page, context }, record: string) => {
    const activeLink = page
      .getByRole("navigation", { name: "Settings sections" })
      .locator('[aria-current="page"]')
    const label = await activeLink.textContent()
    expect(label).toBeTruthy()
    const newTab = await context.newPage()
    await newTab.goto(page.url())
    await expect(newTab).toHaveURL(page.url())
    await expect(
      newTab
        .getByRole("navigation", { name: "Settings sections" })
        .locator('[aria-current="page"]'),
    ).toHaveText(label ?? "", { timeout: DATA_TIMEOUT })
    await findSettingsCell(newTab, record)
    await newTab.close()
  },
)

Given(
  "I authenticate the settings fixture {string}",
  async ({ authenticateAsProviderUser }, email: string) => {
    await authenticateAsProviderUser(email, undefined, "ci-pipeline")
  },
)

Then("settings access should be denied", async ({ page }) => {
  await expect(
    page.getByRole("main").getByText("No settings available", { exact: true }),
  ).toBeVisible()
  await expect(page.getByRole("table")).toHaveCount(0)
  await expect(
    page.getByRole("navigation", { name: "Settings sections" }),
  ).toHaveCount(0)
})

Then(
  "the {string} settings link should be hidden",
  async ({ page }, section: string) => {
    await expect(
      page
        .getByRole("navigation", { name: "Settings sections" })
        .getByRole("link", {
          name: new RegExp(`^${escapeRegex(section)}(?:\\s+\\d+)?$`),
        }),
    ).toHaveCount(0)
  },
)

When("I go back in settings history", async ({ page }) => {
  await page.goBack()
})

When(
  "I go back to Roles while its rows and counts are refreshing",
  async ({ page }) => {
    const requested = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const continued = Promise.withResolvers<void>()
    const remaining = new Set([
      "query AllSettingsRoles(",
      "query SettingsCounts(",
    ])
    let held = 0
    await page.route("**/graphql", async (route) => {
      const body = route.request().postData()
      const operation = [...remaining].find((text) => body?.includes(text))
      if (operation !== undefined) {
        remaining.delete(operation)
        held++
        if (remaining.size === 0) requested.resolve()
        await release.promise
        try {
          await route.continue()
        } finally {
          if (--held === 0) continued.resolve()
        }
      } else {
        await route.continue()
      }
    })
    try {
      await page.goBack()
      await requested.promise
      await expect(page.getByRole("table")).toHaveCount(0)
      await expect(
        page
          .getByRole("navigation", { name: "Settings sections" })
          .getByRole("link", { name: "Roles", exact: true }),
      ).toHaveAttribute("aria-current", "page")
      const sections = page.getByRole("navigation", {
        name: "Settings sections",
      })
      for (const name of [
        "Users",
        "Invited Users",
        "Authentication Providers",
      ]) {
        await expect(
          sections.getByRole("link", { name, exact: true }),
        ).toBeVisible()
      }
    } finally {
      release.resolve()
      if (held) await continued.promise
      await page.unroute("**/graphql")
    }
    await expect(
      page.getByRole("link", { name: /^Invited Users\s+[1-9]\d*$/ }),
    ).toBeVisible({ timeout: DATA_TIMEOUT })
  },
)

When("I go forward in settings history", async ({ page }) => {
  await page.goForward()
})

Then(
  "the active settings section should be {string} at {string}",
  async ({ page }, section: string, path: string) => {
    await expect(page).toHaveURL(new RegExp(`${escapeRegex(path)}$`))
    await expect(
      page.getByRole("link", {
        name: new RegExp(`^${escapeRegex(section)}\\s+\\d+$`),
      }),
    ).toHaveAttribute("aria-current", "page")
  },
)

When(
  "I open the {string} settings table",
  async ({ page }, tableName: string) => {
    await page
      .getByRole("link", {
        name: new RegExp(`^${escapeRegex(tableName)}(?:\\s+\\d+)?$`),
      })
      .click()
  },
)

When(
  "I open the Roles settings table and check that only Roles rows are requested",
  async ({ page }) => {
    const collectionFields = new Set([
      "allUsers",
      "allInvitations",
      "allRoles",
      "allOAuthProviders",
    ])
    const requestedCollections = new Set<string>()
    const recordCollections = (request: Request) => {
      if (request.method() !== "POST") return
      if (!request.headers()["content-type"]?.startsWith("application/json"))
        return
      const body: unknown = request.postDataJSON()
      if (
        !body ||
        typeof body !== "object" ||
        !("query" in body) ||
        typeof body.query !== "string"
      )
        return
      visit(parse(body.query), {
        Field({ name }) {
          if (collectionFields.has(name.value))
            requestedCollections.add(name.value)
        },
      })
    }
    const sections = page.getByRole("navigation", { name: "Settings sections" })

    page.on("request", recordCollections)
    try {
      await sections.getByRole("link", { name: /^Roles(?:\s+\d+)?$/ }).click()
      await expect(
        page.getByRole("cell", { exact: true, name: "Administrator" }),
      ).toBeVisible({ timeout: DATA_TIMEOUT })
      for (const label of [
        "Users",
        "Invited Users",
        "Roles",
        "Authentication Providers",
      ]) {
        await expect(
          sections.getByRole("link", {
            name: new RegExp(`^${label}\\s+[1-9]\\d*$`),
          }),
        ).toBeVisible({ timeout: DATA_TIMEOUT })
      }
      expect([...requestedCollections]).toEqual(["allRoles"])
    } finally {
      page.off("request", recordCollections)
    }
  },
)

Given(
  "the settings {string} request fails",
  async ({ page }, operation: string) => {
    await page.route("**/graphql", async (route) => {
      if (route.request().postData()?.includes(`query ${operation}(`)) {
        await route.fulfill({
          json: { errors: [{ message: "Settings request unavailable" }] },
        })
      } else {
        await route.continue()
      }
    })
  },
)

Then(
  "settings should show {string} without a badge on {string}",
  async ({ page }, error: string, section: string) => {
    await expect(page.getByText(error)).toBeVisible({ timeout: DATA_TIMEOUT })
    await expect(
      page
        .getByRole("navigation", { name: "Settings sections" })
        .getByRole("link", { name: section, exact: true }),
    ).toBeVisible()
  },
)

Then(
  "settings should show a count error without inactive badges",
  async ({ page }) => {
    await expect(
      page.getByText("Could not load settings section counts.", {
        exact: true,
      }),
    ).toBeVisible({ timeout: DATA_TIMEOUT })
    await expect(
      page.getByRole("cell", { exact: true, name: "Administrator" }),
    ).toBeVisible({ timeout: DATA_TIMEOUT })
    const sections = page.getByRole("navigation", { name: "Settings sections" })
    for (const label of [
      "Users",
      "Invited Users",
      "Authentication Providers",
    ]) {
      await expect(
        sections.getByRole("link", { name: label, exact: true }),
      ).toBeVisible()
    }
  },
)

Then("I should see settings users table data", async ({ page }) => {
  await expect(
    page.getByRole("heading", {
      level: 2,
      name: "Users & Sign-in",
      exact: true,
    }),
  ).toBeVisible({ timeout: DATA_TIMEOUT })
  await expect(
    page.getByRole("link", {
      name: "Users & Sign-in Manage users, invitations, roles, and sign-in providers.",
      exact: true,
    }),
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { level: 1, name: "Users & Sign-in" }),
  ).toBeVisible()
  await expect(page.getByRole("columnheader", { name: "Email" })).toBeVisible({
    timeout: DATA_TIMEOUT,
  })
  await findSettingsCell(page, "ci@example.com")
})

Then(
  "the settings user row for {string} should be visible",
  async ({ page }, email: string) => {
    await expect(page.getByRole("columnheader", { name: "Email" })).toBeVisible(
      { timeout: DATA_TIMEOUT },
    )
    await findSettingsCell(page, email)
  },
)

Then("I should see settings roles table data", async ({ page }) => {
  await expect(
    page.getByRole("columnheader", { name: "Role Name" }),
  ).toBeVisible({ timeout: DATA_TIMEOUT })
  await expect(
    page.getByRole("cell", { exact: true, name: "Administrator" }),
  ).toBeVisible({ timeout: DATA_TIMEOUT })
})

Then("I should see settings invitations table data", async ({ page }) => {
  // Wait for the dedicated pending invitation before checking the loaded UI.
  // Other fixture users can be legacy-closed after previous runs.
  await expect(
    page.getByRole("cell", { name: "settings-e2e@example.com" }),
  ).toBeVisible({ timeout: DATA_TIMEOUT })
  await expect(
    page.getByRole("heading", { name: "Invited Users", exact: true }),
  ).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Legacy closed" })).toHaveCount(
    0,
  )
  await expect(
    page.getByText(
      "Invite people to join your organisation and track whether they’ve accepted.",
      { exact: true },
    ),
  ).toBeVisible()
  await expect(page.getByRole("columnheader", { name: "Roles" })).toBeVisible()
  await expect(page.getByRole("columnheader", { name: "Status" })).toBeVisible()
})

Then("I should see settings providers table data", async ({ page }) => {
  await expect(
    page.getByRole("columnheader", { name: "Provider Name" }),
  ).toBeVisible({ timeout: DATA_TIMEOUT })
  await expect(page.getByRole("cell", { name: /google/i })).toBeVisible({
    timeout: DATA_TIMEOUT,
  })
})

When(
  "I open the settings user row for {string}",
  async ({ page }, email: string) => {
    await (await findSettingsCell(page, email)).click()
  },
)

Then(
  "I should see the settings user detail for {string}",
  async ({ page }, email: string) => {
    await expect(page).toHaveURL(/\/settings\/users\//, {
      timeout: DATA_TIMEOUT,
    })
    await expect(page.getByRole("heading", { name: "Edit User" })).toBeVisible()
    await expect(page.getByRole("textbox", { name: "Email" })).toHaveValue(
      email,
    )
  },
)
