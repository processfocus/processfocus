import { expect } from "@playwright/test"
import { Given, Then, When, appDialog } from "./fixtures"
import { signInThroughDummy, switchDashboardRole } from "./initial-sync-browser"

// Like the Processes journey, observe each new document continuously: old
// pre-switch rows cannot satisfy readiness and a one-paint empty flash fails.
const observeBootstrap = () => {
  sessionStorage.setItem("execution-sync:allow-empty", "false")
  sessionStorage.setItem("execution-sync:false-empty", "false")
  new MutationObserver(() => {
    if (sessionStorage.getItem("execution-sync:allow-empty") === "true") return
    if (
      /No executions in this view|No matching executions|Execution not found/.test(
        document.body?.innerText ?? "",
      )
    ) {
      sessionStorage.setItem("execution-sync:false-empty", "true")
    }
  }).observe(document, { childList: true, subtree: true, characterData: true })
}

Given(
  "I have running and historical executions in the disposable organisation",
  async ({ page }) => {
    await signInThroughDummy(page, "/processes")
    await switchDashboardRole(page, "/Administrator")
    // Submit a running purchase and a real system-start process that completes.
    await page.goto(
      "/processes/start/finance/purchase-request/Submit%20request",
    )
    await page.locator('input[name="item"]').fill("Initial sync 3245")
    await page.locator('input[name="value"]').fill("500")
    await page.getByRole("button", { name: "Submit", exact: true }).click()
    await expect(page).not.toHaveURL(/\/processes\/start\//)
    await page.goto("/processes/start/operations/hello-system-start/Hello")
    await page.getByRole("button", { name: "Submit", exact: true }).click()
    await expect(page).not.toHaveURL(/\/processes\/start\//)
    await page.goto("/executions?filter=completed")
    await expect(
      page
        .getByRole("heading", {
          level: 4,
          name: "Hello System Start",
          exact: true,
        })
        .first(),
    ).toBeVisible({ timeout: 30_000 })
    // Start with an empty client cache without changing the server's fixtures.
    await page.evaluate(() => localStorage.clear())
    // Unmount the authenticated app before the next login changes its cookies.
    await page.goto("about:blank")
  },
)

Given(
  "the initial execution pull is held with a {string} result",
  async ({ page, scenarioState }, result: string) => {
    await page.unroute("**/graphql")
    const gate = Promise.withResolvers<void>()
    const requested = Promise.withResolvers<void>()
    scenarioState.set("executionSyncResult", result)
    scenarioState.set("executionSyncRelease", gate.resolve)
    scenarioState.set("executionSyncRequested", requested.promise)
    scenarioState.set(
      "executionSyncPreviousDocument",
      await page.evaluate(() => performance.timeOrigin),
    )
    await page.addInitScript(observeBootstrap)
    let failed = false
    await page.route("**/graphql", async (route) => {
      if (!route.request().postData()?.includes("pullExecution("))
        return route.continue()
      requested.resolve()
      await gate.promise
      if (result === "failure" && !failed) {
        failed = true
        await route.fulfill({
          status: 503,
          json: { errors: [{ message: "Controlled initial pull failure" }] },
        })
      } else {
        await route.continue()
      }
    })
  },
)

Then(
  "the new Executions scope stays loading without a false empty result",
  async ({ page, scenarioState }) => {
    await scenarioState.get("executionSyncRequested")
    expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(
      scenarioState.get("executionSyncPreviousDocument"),
    )
    await expect(
      page.getByLabel("Loading executions", { exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole("heading", {
        level: 4,
        name: "Purchase Request",
        exact: true,
      }),
    ).toHaveCount(0)
    await page.waitForTimeout(350)
    expect(
      await page.evaluate(() =>
        sessionStorage.getItem("execution-sync:false-empty"),
      ),
    ).toBe("false")
  },
)

When(
  "I release the initial execution pull",
  async ({ page, scenarioState }) => {
    const empty = scenarioState.get("executionSyncResult") === "empty"
    const response = empty
      ? page.waitForResponse(
          (response) =>
            response.request().postData()?.includes("pullExecution(") === true,
        )
      : undefined
    if (empty)
      await page.evaluate(() =>
        sessionStorage.setItem("execution-sync:allow-empty", "true"),
      )
    const release = scenarioState.get("executionSyncRelease")
    if (typeof release !== "function") throw new Error("No held execution pull")
    release()
    if (response) {
      const result = await response
      expect(result.ok()).toBe(true)
      const body: unknown = await result.json()
      expect(body).not.toHaveProperty("errors")
      expect(body).toMatchObject({ data: { pullExecution: { documents: [] } } })
    }
  },
)

Then(
  "Executions finishes with the {string} result without a false empty flash",
  async ({ page }, result: string) => {
    if (result === "failure") {
      await expect(
        page
          .getByRole("alert")
          .filter({ hasText: "Executions could not finish loading" }),
      ).toBeVisible()
      await page
        .getByRole("button", { name: "Retry loading executions" })
        .click()
    }
    if (result === "empty") {
      await expect(
        page.getByRole("heading", {
          name: "No executions in this view",
          exact: true,
        }),
      ).toBeVisible()
    } else {
      await expect(
        page
          .getByRole("heading", {
            level: 4,
            name: "Purchase Request",
            exact: true,
          })
          .first(),
      ).toBeVisible({ timeout: 20_000 })
    }
    await expect(
      page.getByLabel("Loading executions", { exact: true }),
    ).not.toBeVisible()
    await expect(
      page.getByText("Loading executions…", { exact: true }),
    ).not.toBeVisible()
    expect(
      await page.evaluate(() =>
        sessionStorage.getItem("execution-sync:false-empty"),
      ),
    ).toBe("false")
  },
)

Then(
  "Executions filters show historical rows and explain misses",
  async ({ page }) => {
    // Now a filter miss is legitimate; the initial bootstrap observer is done.
    await page.evaluate(() =>
      sessionStorage.setItem("execution-sync:allow-empty", "true"),
    )
    await page.getByRole("button", { name: /^Completed\b/ }).click()
    await expect(page).toHaveURL(/filter=completed/)
    await expect(
      page.getByText("Completed", { exact: true }).first(),
    ).toBeVisible()
    await expect(
      page
        .getByRole("heading", {
          level: 4,
          name: "Hello System Start",
          exact: true,
        })
        .first(),
    ).toBeVisible()
    await page.getByRole("button", { name: /^Not started\b/ }).click()
    await expect(page).toHaveURL(/filter=not-started/)
    await expect(
      page.getByRole("heading", { name: "No matching executions" }),
    ).toBeVisible()
    await expect(
      page.getByText(
        "There are no executions matching the selected filter. Choose another filter to see executions.",
      ),
    ).toBeVisible()
    await page.getByRole("button", { name: /^In Progress\b/ }).click()
    await expect(page).toHaveURL((url) => !url.searchParams.has("filter"))
    await expect(
      page.getByText("Running", { exact: true }).first(),
    ).toBeVisible()
  },
)

When(
  "I delay execution refresh and revisit cached Executions",
  async ({ page, scenarioState }) => {
    await page.unroute("**/graphql")
    const gate = Promise.withResolvers<void>()
    const requested = Promise.withResolvers<void>()
    scenarioState.set("executionRefreshRelease", gate.resolve)
    await page.route("**/graphql", async (route) => {
      if (!route.request().postData()?.includes("pullExecution("))
        return route.continue()
      requested.resolve()
      await gate.promise
      await route.fulfill({
        status: 503,
        json: { errors: [{ message: "Controlled refresh failure" }] },
      })
    })
    await page.goto("/executions", { waitUntil: "domcontentloaded" })
    await requested.promise
  },
)

Then(
  "cached Executions remain usable during refresh and failure",
  async ({ page, scenarioState }) => {
    const card = page.getByRole("button", { name: /^Purchase Request/ }).first()
    await expect(card).toBeVisible()
    await expect(
      page.getByLabel("Loading executions", { exact: true }),
    ).not.toBeVisible()
    await page.getByRole("button", { name: /^Not started\b/ }).click()
    await expect(page).toHaveURL(/filter=not-started/)
    await expect(
      page.getByText("Loading executions…", { exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole("heading", { name: "No matching executions" }),
    ).not.toBeVisible()
    await page.getByRole("button", { name: /^In Progress\b/ }).click()
    await expect(page).toHaveURL((url) => !url.searchParams.has("filter"))
    await expect(card).toBeVisible()
    await card.click()
    await expect(page.getByText("Timeline", { exact: true })).toBeVisible()
    const detail = (await appDialog(page).isVisible())
      ? appDialog(page)
      : page.getByRole("main")
    const release = scenarioState.get("executionRefreshRelease")
    if (typeof release !== "function")
      throw new Error("No held execution refresh")
    release()
    await expect(
      detail
        .getByRole("alert")
        .filter({ hasText: "Executions could not finish loading" }),
    ).toBeVisible()
    await expect(page.getByText("Timeline", { exact: true })).toBeVisible()
    await page.unroute("**/graphql")
    await detail
      .getByRole("button", { name: "Retry loading executions" })
      .click()
    await expect(
      detail
        .getByRole("alert")
        .filter({ hasText: "Executions could not finish loading" }),
    ).not.toBeVisible({ timeout: 20_000 })
  },
)
