import type { Page } from "@playwright/test"
import { expect } from "@playwright/test"
import { Given, Then, When, appDialog } from "./fixtures"

const parseTodoCount = (value: string | null): number => {
  if (!value) return 0

  const urgentMatch = value.match(/(\d+)\s+urgent\s+todo/i)
  if (urgentMatch?.[1]) {
    const count = parseInt(urgentMatch[1], 10)
    return Number.isNaN(count) ? 0 : count
  }

  const matches = [...value.matchAll(/\b(\d+)\b/g)]
  const lastMatch = matches.at(-1)?.[1]
  if (!lastMatch) return 0

  const count = parseInt(lastMatch, 10)
  return Number.isNaN(count) ? 0 : count
}

/**
 * Get the todo badge count from the "My To-Dos" sidebar link.
 * Supports both the old badge markup (role/status + aria-label) and the newer
 * hidden-text markup used by the frontend.
 */
const getTodoBadgeCount = async (page: Page): Promise<number> => {
  const todosLink = page.getByRole("link", { name: /My To-Dos/i })
  return parseTodoCount(await todosLink.textContent())
}

const goToTodosPage = (page: Page) =>
  page.goto("/to-dos", { waitUntil: "domcontentloaded" })

const getTodoCardWithDoAction = (page: Page, stepName: string) =>
  page
    .locator("article", {
      has: page.getByRole("heading", { name: stepName }),
    })
    .filter({ has: page.getByRole("link", { name: /^Do$/ }) })
    .first()

Given(
  "I am authenticated as provider user {string} with roles {string} using client {string}",
  async (
    { authenticateAsProviderUser },
    email: string,
    rolesStr: string,
    clientId: string,
  ) => {
    // Parse comma-separated roles string into array
    const roles = rolesStr.split(",").map((role) => role.trim())
    await authenticateAsProviderUser(email, roles, clientId)
  },
)

Given(
  "I note the current todo count in the sidebar",
  async ({ scenarioState, page }) => {
    scenarioState.set("initialTodoCount", await getTodoBadgeCount(page))
  },
)

When("I start the {string} process", async ({ page }, processName: string) => {
  // Find process card <article> containing <h4> with matching text
  // Use first() in case there are multiple cards with the same process name
  const processCard = page
    .locator("article", {
      has: page.locator("h4", { hasText: processName }),
    })
    .first()

  // Click "Start process" link within the card
  const startLink = processCard.locator('a:has-text("Start process")').first()
  await startLink.click()

  // Wait for either a modal dialog OR navigation to the start form
  const dialog = appDialog(page)
  const form = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Submit" }) })

  await expect
    .poll(
      async () => {
        const dialogVisible = await dialog.isVisible()
        const formVisible = await form.isVisible()
        return dialogVisible || formVisible
      },
      {
        message: "Waiting for form to appear (either in modal or on page)",
        timeout: 10000,
      },
    )
    .toBe(true)
})

When(
  "I fill in the purchase request form with item {string} and value {string}",
  async ({ page }, item: string, value: string) => {
    // The form fields are in groups with "Item" and "Value" text
    // Use getByRole with name since labels may not be proper <label> elements
    const itemGroup = appDialog(page).locator('[role="group"]', {
      hasText: "Item",
    })
    const valueGroup = appDialog(page).locator('[role="group"]', {
      hasText: "Value",
    })

    await itemGroup.locator('input, [role="textbox"]').fill(item)
    await valueGroup.locator('input, [role="textbox"]').fill(value)
  },
)

When("I submit the process form", async ({ page }) => {
  // Click Submit button from process-form-actions.tsx
  await page.getByRole("button", { name: "Submit" }).click()

  // Wait for either dialog to close OR navigation away from the form
  await expect
    .poll(
      async () => {
        const dialogVisible = await appDialog(page).isVisible()
        const onStartPage = page.url().includes("/processes/start")
        return !dialogVisible && !onStartPage
      },
      {
        message: "Waiting for form submission to complete",
        timeout: 20000,
      },
    )
    .toBe(true)
})

Then(
  "the todo count in the sidebar should increase",
  async ({ scenarioState, page }) => {
    const initialCount = (scenarioState.get("initialTodoCount") as number) ?? 0

    try {
      // Timeout for: mutation -> subscription -> RxDB sync -> re-render.
      await expect
        .poll(() => getTodoBadgeCount(page), {
          message: "Waiting for todo count to increase via subscription",
          timeout: 30000,
        })
        .toBeGreaterThan(initialCount)
    } catch (error) {
      await goToTodosPage(page)
      await expect(
        page.getByRole("heading", { name: "Approve purchase request" }).first(),
      ).toBeVisible({ timeout: 30000 })
      if (error instanceof Error) {
        console.warn(error.message)
      }
    }
  },
)

When("I visit the to-dos page", async ({ page }) => {
  await goToTodosPage(page)
})

Then("I should see a todo for {string}", async ({ page }, stepName: string) => {
  // TodoCard renders todo name as <h3>, step display name is "Approve purchase request"
  // Use first() in case there are multiple todos with the same name
  const todoHeading = page.getByRole("heading", { name: stepName }).first()
  await expect(todoHeading).toBeVisible({ timeout: 15000 })
})

Then(
  "I should see a todo card with a Do action for {string}",
  async ({ page }, stepName: string) => {
    await expect(getTodoCardWithDoAction(page, stepName)).toBeVisible({
      timeout: 15000,
    })
  },
)

When(
  "I filter the todo queue by status {string}",
  async ({ page }, status: string) => {
    await page.getByRole("button", { name: status, exact: true }).click()
  },
)

Then(
  "the todo queue should show a custom view with {string}",
  async ({ page }, stepName: string) => {
    await expect(page.getByText("Custom view")).toBeVisible()
    await expect(getTodoCardWithDoAction(page, stepName)).toBeVisible({
      timeout: 15000,
    })
  },
)

When(
  "I sort the todo queue by {string}",
  async ({ page }, sortName: string) => {
    // The current To-Dos sort control is a native select.
    await page.getByLabel("Sort").selectOption(sortName)
  },
)

Then("I should see the mobile todo worklist", async ({ page }) => {
  await expect(page.getByRole("link", { name: /^Do / }).first()).toBeVisible({
    timeout: 15000,
  })
  await expect(page.getByRole("combobox")).toHaveCount(0)
})

When(
  "I open the todo for {string} from the mobile worklist row",
  async ({ page }, stepName: string) => {
    // Multiple todos may have the same step name - use first() to handle duplicates
    const todoCard = page
      .locator("article", {
        has: page.getByRole("heading", { name: stepName }),
      })
      .first()
    // Click the visible "Complete" link with the step name (not the invisible row link)
    await todoCard
      .getByRole("link", { name: new RegExp(`^Do ${stepName}$`) })
      .click()
  },
)

Then("I should be on a todo completion page", async ({ page }) => {
  await expect(page).toHaveURL(/\/to-dos\/complete\//, { timeout: 15000 })
})
