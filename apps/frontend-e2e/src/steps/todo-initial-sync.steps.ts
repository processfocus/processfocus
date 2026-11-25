import type { Page } from "@playwright/test"
import { expect } from "@playwright/test"
import { Given, Then, When } from "./fixtures"

const observeBootstrap = () => {
  sessionStorage.setItem("todo-sync:released", "false")
  sessionStorage.setItem("todo-sync:false-empty", "false")
  sessionStorage.setItem("todo-sync:document", String(performance.timeOrigin))
  new MutationObserver(() => {
    if (sessionStorage.getItem("todo-sync:released") === "true") return
    if (
      /No to-dos yet|No todos match these filters/.test(
        document.body?.innerText ?? "",
      )
    ) {
      sessionStorage.setItem("todo-sync:false-empty", "true")
    }
  }).observe(document, { childList: true, subtree: true, characterData: true })
}

const visibleTodo = (page: Page) =>
  page
    .getByRole("heading", { name: "Approve purchase request", exact: true })
    .first()

Given(
  "the initial todo pull is held with a {string} result",
  async ({ page, scenarioState }, result: string) => {
    await page.unroute("**/graphql")
    const gate = Promise.withResolvers<void>()
    const requested = Promise.withResolvers<void>()
    scenarioState.set("todoSyncResult", result)
    scenarioState.set("todoSyncRelease", gate.resolve)
    scenarioState.set("todoSyncRequested", requested.promise)
    scenarioState.set(
      "todoSyncPreviousDocument",
      await page.evaluate(() => performance.timeOrigin),
    )
    await page.addInitScript(observeBootstrap)
    let failed = false
    await page.route("**/graphql", async (route) => {
      if (!route.request().postData()?.includes("pullTodo("))
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
  "I sign in to To-Dos through the local dummy provider",
  async ({ page, authenticateAsProviderUser }) => {
    await authenticateAsProviderUser("ci@example.com")
    await page.context().clearCookies()
    await page.goto("/login?redirect=/to-dos", {
      waitUntil: "domcontentloaded",
    })
    await page.waitForLoadState("networkidle")
    // Seed work through the real UI, then model a fresh browser cache at login.
    // The unprotected login page has no mounted collection provider.
    await page.evaluate(async () => {
      const databases = await indexedDB.databases()
      await Promise.all(
        databases.map(
          (database) =>
            new Promise<void>((resolve, reject) => {
              if (!database.name) return resolve()
              const request = indexedDB.deleteDatabase(database.name)
              request.onsuccess = () => resolve()
              request.onerror = () => reject(request.error)
              request.onblocked = () =>
                reject(new Error("Cache deletion blocked"))
            }),
        ),
      )
    })
    await page.getByRole("button", { name: "Sign in with dummy" }).click()
    await expect(page).toHaveURL((url) => url.pathname === "/to-dos", {
      timeout: 30_000,
    })
  },
)

Then(
  "the new To-Dos scope stays loading without a false empty result",
  async ({ page, scenarioState }) => {
    await scenarioState.get("todoSyncRequested")
    expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(
      scenarioState.get("todoSyncPreviousDocument"),
    )
    await expect(
      page.getByText("Loading todos...", { exact: true }),
    ).toBeVisible()
    await expect(visibleTodo(page)).not.toBeVisible()
    // Hold beyond a paint, observing every DOM mutation throughout the transition.
    await page.waitForTimeout(350)
    expect(
      await page.evaluate(() =>
        sessionStorage.getItem("todo-sync:false-empty"),
      ),
    ).toBe("false")
  },
)

When("I release the initial todo pull", async ({ page, scenarioState }) => {
  const emptyResponse =
    scenarioState.get("todoSyncResult") === "empty"
      ? page.waitForResponse(
          (response) =>
            response.request().postData()?.includes("pullTodo(") === true,
        )
      : undefined
  if (scenarioState.get("todoSyncResult") === "empty") {
    await page.evaluate(() =>
      sessionStorage.setItem("todo-sync:released", "true"),
    )
  }
  const release = scenarioState.get("todoSyncRelease")
  if (typeof release !== "function") throw new Error("No held pull")
  release()
  if (emptyResponse) {
    const response = await emptyResponse
    expect(response.ok()).toBe(true)
    const body: unknown = await response.json()
    expect(body).not.toHaveProperty("errors")
    expect(body).toMatchObject({ data: { pullTodo: { documents: [] } } })
  }
})

Then(
  "To-Dos finishes with the {string} result without a false empty flash",
  async ({ page }, result: string) => {
    if (result === "failure") {
      await expect(
        page
          .getByRole("alert")
          .filter({ hasText: "To-dos could not finish loading" }),
      ).toContainText("To-dos could not finish loading")
      await expect(
        page.getByRole("heading", { name: "No to-dos yet" }),
      ).not.toBeVisible()
      await page.getByRole("button", { name: "Retry loading to-dos" }).click()
    }
    if (result === "empty") {
      await expect(
        page.getByRole("heading", { name: "No to-dos yet", exact: true }),
      ).toBeVisible()
    } else {
      await expect(visibleTodo(page)).toBeVisible({ timeout: 20_000 })
    }
    await expect(
      page.getByText("Loading todos...", { exact: true }),
    ).not.toBeVisible()
    expect(
      await page.evaluate(() =>
        sessionStorage.getItem("todo-sync:false-empty"),
      ),
    ).toBe("false")
  },
)

Then("To-Dos filter misses describe the active filters", async ({ page }) => {
  await page.getByRole("button", { name: "Drafts", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "No todos match these filters" }),
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "No to-dos yet" }),
  ).not.toBeVisible()
  await page.getByRole("button", { name: "All Tasks", exact: true }).click()
})

When(
  "I delay todo refresh and revisit the cached queue",
  async ({ page, scenarioState }) => {
    await page.unroute("**/graphql")
    const gate = Promise.withResolvers<void>()
    const requested = Promise.withResolvers<void>()
    scenarioState.set("todoRefreshRelease", gate.resolve)
    await page.route("**/graphql", async (route) => {
      if (route.request().postData()?.includes("pullTodo(")) {
        requested.resolve()
        await gate.promise
        await route.fulfill({
          status: 503,
          json: { errors: [{ message: "Controlled refresh failure" }] },
        })
        return
      }
      await route.continue()
    })
    await page.goto("/to-dos", { waitUntil: "domcontentloaded" })
    await requested.promise
  },
)

Then(
  "cached To-Dos remain usable during refresh",
  async ({ page, scenarioState }) => {
    await expect(visibleTodo(page)).toBeVisible()
    await expect(
      page.getByLabel("Loading to-dos", { exact: true }),
    ).not.toBeVisible()
    // A filter miss is still incomplete while this reopened cache is syncing.
    const drafts = page.getByRole("button", { name: "Drafts", exact: true })
    if (await drafts.isVisible()) {
      await drafts.click()
      await expect(
        page.getByRole("heading", { name: "No todos match these filters" }),
      ).not.toBeVisible()
      await expect(
        page.getByRole("status").filter({ hasText: "Loading todos..." }),
      ).toBeVisible()
      await page.getByRole("button", { name: "All Tasks", exact: true }).click()
    }
    const failure = page.waitForResponse(
      (response) =>
        response.request().postData()?.includes("pullTodo(") === true &&
        response.status() === 503,
    )
    const release = scenarioState.get("todoRefreshRelease")
    if (typeof release !== "function") throw new Error("No held refresh")
    release()
    await failure
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "To-dos could not finish loading" }),
    ).toBeVisible()
    await expect(visibleTodo(page)).toBeVisible()
    await expect(
      page.getByLabel("Loading to-dos", { exact: true }),
    ).not.toBeVisible()
  },
)
