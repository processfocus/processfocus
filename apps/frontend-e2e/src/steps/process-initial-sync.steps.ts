import type { Page } from "@playwright/test"
import { expect } from "@playwright/test"
import { Given, Then, When } from "./fixtures"
import { signInThroughDummy, switchDashboardRole } from "./initial-sync-browser"

const observeBootstrap = () => {
  sessionStorage.setItem("process-sync:released", "false")
  sessionStorage.setItem("process-sync:false-empty", "false")
  sessionStorage.setItem(
    "process-sync:document",
    String(performance.timeOrigin),
  )
  new MutationObserver(() => {
    if (sessionStorage.getItem("process-sync:released") === "true") return
    if (
      /No processes found|No matching processes/.test(
        document.body?.innerText ?? "",
      )
    ) {
      sessionStorage.setItem("process-sync:false-empty", "true")
    }
  }).observe(document, { childList: true, subtree: true, characterData: true })
}

const visibleProcess = (page: Page) =>
  page.getByRole("heading", { name: "Purchase Request", exact: true })

Given(
  "I am using the {string} Processes viewport",
  async ({ page }, viewport: string) => {
    await page.setViewportSize(
      viewport === "mobile"
        ? { width: 390, height: 844 }
        : { width: 1440, height: 1000 },
    )
  },
)

Given(
  "the initial process pull is held with a {string} result",
  async ({ page, scenarioState }, result: string) => {
    const gate = Promise.withResolvers<void>()
    const requested = Promise.withResolvers<void>()
    scenarioState.set("processSyncResult", result)
    scenarioState.set("processSyncRelease", gate.resolve)
    scenarioState.set("processSyncRequested", requested.promise)
    scenarioState.set(
      "processSyncPreviousDocument",
      await page.evaluate(() => performance.timeOrigin),
    )
    await page.addInitScript(observeBootstrap)
    let failed = false
    await page.route("**/graphql", async (route) => {
      if (!route.request().postData()?.includes("pullProcess("))
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

When(
  /^I sign in to (Processes|Executions) through the local dummy provider$/,
  async ({ page, authenticateAsProviderUser }, surface: string) => {
    const path = `/${surface.toLowerCase()}`
    await authenticateAsProviderUser("ci@example.com")
    await signInThroughDummy(page, path)
  },
)

When(
  "I switch the Dashboard Role to {string}",
  async ({ page }, role: string) => {
    await switchDashboardRole(page, role)
  },
)

Then(
  "the new Processes scope stays loading without a false empty result",
  async ({ page, scenarioState }) => {
    await scenarioState.get("processSyncRequested")
    expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(
      scenarioState.get("processSyncPreviousDocument"),
    )
    await expect(
      page.getByLabel("Loading processes", { exact: true }),
    ).toBeVisible()
    await expect(visibleProcess(page)).not.toBeVisible()
    // Hold beyond a paint, observing every DOM mutation throughout the transition.
    await page.waitForTimeout(350)
    expect(
      await page.evaluate(() =>
        sessionStorage.getItem("process-sync:false-empty"),
      ),
    ).toBe("false")
  },
)

When("I release the initial process pull", async ({ page, scenarioState }) => {
  const emptyResponse =
    scenarioState.get("processSyncResult") === "empty"
      ? page.waitForResponse(
          (response) =>
            response.request().postData()?.includes("pullProcess(") === true,
        )
      : undefined
  if (scenarioState.get("processSyncResult") === "empty") {
    await page.evaluate(() =>
      sessionStorage.setItem("process-sync:released", "true"),
    )
  }
  const release = scenarioState.get("processSyncRelease")
  if (typeof release !== "function") throw new Error("No held pull")
  release()
  if (emptyResponse) {
    const response = await emptyResponse
    expect(response.ok()).toBe(true)
    const body: unknown = await response.json()
    expect(body).not.toHaveProperty("errors")
    expect(body).toMatchObject({ data: { pullProcess: { documents: [] } } })
  }
})

Then(
  "Processes finishes with the {string} result without a false empty flash",
  async ({ page }, result: string) => {
    if (result === "failure") {
      await expect(
        page
          .getByRole("alert")
          .filter({ hasText: "Processes could not finish loading" }),
      ).toContainText("Processes could not finish loading")
      await expect(
        page.getByRole("heading", { name: "No processes found" }),
      ).not.toBeVisible()
      await page
        .getByRole("button", { name: "Retry loading processes" })
        .click()
    }
    if (result === "empty") {
      await expect(
        page.getByRole("heading", { name: "No processes found", exact: true }),
      ).toBeVisible()
    } else {
      await expect(visibleProcess(page)).toBeVisible({ timeout: 20_000 })
    }
    await expect(
      page.getByLabel("Loading processes", { exact: true }),
    ).not.toBeVisible()
    expect(
      await page.evaluate(() =>
        sessionStorage.getItem("process-sync:false-empty"),
      ),
    ).toBe("false")
  },
)

Then(
  "Processes filter misses describe the active filters",
  async ({ page }) => {
    await page.getByPlaceholder("Search processes").fill("no such process 3244")
    await expect(
      page.getByRole("heading", { name: "No matching processes" }),
    ).toBeVisible()
    await expect(
      page.getByText(
        "There are no processes for your organisational unit or role.",
      ),
    ).not.toBeVisible()
    await page.getByRole("button", { name: "★ Favorites" }).click()
    await expect(
      page.getByRole("heading", { name: "No matching processes" }),
    ).toBeVisible()
    await page.getByRole("button", { name: "★ Favorites" }).click()
    await page.getByPlaceholder("Search processes").fill("")
  },
)

When(
  "I delay process refresh and revisit the cached catalog",
  async ({ page, scenarioState }) => {
    await page.unroute("**/graphql")
    const gate = Promise.withResolvers<void>()
    const requested = Promise.withResolvers<void>()
    scenarioState.set("processRefreshRelease", gate.resolve)
    await page.route("**/graphql", async (route) => {
      if (route.request().postData()?.includes("pullProcess(")) {
        requested.resolve()
        await gate.promise
      }
      await route.continue()
    })
    await page.goto("/processes", { waitUntil: "domcontentloaded" })
    await requested.promise
  },
)

Then(
  "cached Processes remain usable during refresh",
  async ({ page, scenarioState }) => {
    await expect(visibleProcess(page)).toBeVisible()
    await expect(
      page.getByLabel("Loading processes", { exact: true }),
    ).not.toBeVisible()
    const release = scenarioState.get("processRefreshRelease")
    if (typeof release !== "function") throw new Error("No held refresh")
    release()
  },
)
