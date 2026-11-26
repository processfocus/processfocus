import { type Request, expect } from "@playwright/test"
import { Then, When, appDialog } from "./fixtures"

When("I inspect the authenticated sidebar HTML", async ({ page, browser }) => {
  const response = await page.request.get("/processes")
  expect(response.ok()).toBe(true)
  // Inspect the actual server response without hydration replacing its fallbacks.
  const htmlContext = await browser.newContext({ javaScriptEnabled: false })
  try {
    const htmlPage = await htmlContext.newPage()
    await htmlPage.setContent(await response.text())
    const sidebar = htmlPage.locator("aside")
    await expect(sidebar.locator('a[href="/processes"]')).toBeAttached()
    // React bailout/error templates in this shell are the mechanism that blocks
    // dev instant validation, even when client hydration later recovers.
    await expect(htmlPage.locator("template[data-dgst]")).toHaveCount(0)
    await expect(sidebar.locator('[role="status"]')).toHaveText(
      "Loading navigation…",
    )
  } finally {
    await htmlContext.close()
  }
})

Then("the deferred sidebar navigation becomes available", async ({ page }) => {
  await page.goto("/processes")
  await expect(
    page.locator('aside a[href="/lists/process-catalog-browsing"]'),
  ).toBeVisible()
  await expect(page.locator('aside [role="status"]')).toHaveCount(0)
})

When(
  "I inspect instant sidebar process navigation",
  async ({ page, instantUI }) => {
    await page.goto("/to-dos")
    await expect(
      page.getByRole("button", { name: "Comfortable", exact: true }),
    ).toBeVisible()
    const link = page.getByRole("link", {
      name: "Processes Browse and start business processes",
      exact: true,
    })
    await expect(link).toBeVisible()
    await instantUI(async () => {
      await link.click()
      await page.waitForURL("**/processes")
      await expect(
        page.getByRole("heading", { name: "Start a process", exact: true }),
      ).toBeVisible()
    })
  },
)

When("I inspect instant workflow navigation", async ({ page, instantUI }) => {
  await page.goto("/processes")
  const link = page.getByRole("link", {
    name: "View workflow information for Purchase Request",
    exact: true,
  })
  await expect(link).toBeVisible()
  await link.hover()
  await instantUI(async () => {
    await link.click()
    await page.waitForURL("**/processes/workflow/**")
    await expect(
      page.getByRole("heading", { name: "Workflow information", exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole("link", { name: "Back to processes" }),
    ).toBeVisible()
    await expect(
      page.getByRole("heading", { name: "Purchase Request", exact: true }),
    ).toHaveCount(0)
  })
})

Then("the workflow data streams after the instant scope", async ({ page }) => {
  await expect(
    page.getByRole("heading", { name: "Purchase Request", exact: true }),
  ).toBeVisible()
})

Then("workflow navigation supports back and forward", async ({ page }) => {
  const destination = page.url()
  await page.goBack()
  await expect(page).toHaveURL(/\/processes$/)
  await expect(
    page.getByRole("heading", { name: "Start a process", exact: true }),
  ).toBeVisible()
  await page.goForward()
  await expect(page).toHaveURL(destination)
  await expect(
    page.getByRole("heading", { name: "Purchase Request", exact: true }),
  ).toBeVisible()
})

When("I inspect instant List navigation", async ({ page, instantUI }) => {
  await page.goto("/processes")
  const link = page.getByRole("link", {
    name: "Process Catalog Browsing Browse imported process metadata without edits",
    exact: true,
  })
  await link.hover()
  await instantUI(async () => {
    await link.click()
    await page.waitForURL("**/lists/process-catalog-browsing")
    await expect(
      page.getByRole("heading", { name: "List", exact: true }),
    ).toBeVisible()
    await expect(page.getByRole("table")).toHaveCount(0)
  })
})

Then(
  "the process form values survive back, forward and full-page reopening",
  async ({ page }) => {
    const destination = page.url()
    await expect(appDialog(page)).toBeVisible()
    await page.goBack()
    await expect(page).toHaveURL(/\/processes$/)
    await expect(appDialog(page)).toBeHidden()
    await page.goForward()
    await expect(page).toHaveURL(destination)
    await expect(appDialog(page)).toBeVisible()
    await expect(
      page
        .locator('[role="group"]', { hasText: "Item" })
        .getByRole("textbox")
        .filter({ visible: true }),
    ).toHaveValue("Navigation draft")
    // A document navigation also restores the values without the intercepted modal.
    await page.goto(destination)
    await expect(appDialog(page)).toHaveCount(0)
    await expect(
      page
        .locator('[role="group"]', { hasText: "Item" })
        .getByRole("textbox")
        .filter({ visible: true }),
    ).toHaveValue("Navigation draft")
  },
)

When(
  "I inspect prefetch cost across the process catalog",
  async ({ page, instantUI }) => {
    const requests: Request[] = []
    page.on("request", (request) => requests.push(request))
    await page.goto("/processes")
    const links = page.getByRole("link", {
      name: /^View workflow information for /,
    })
    await expect(links.first()).toBeVisible()
    const count = await links.count()
    expect(count).toBeGreaterThan(1)
    for (const link of await links.all()) await link.hover()

    // The real framework lock still permits prefetches, but blocks fresh data.
    await instantUI(async () => {
      await links.last().click()
      await page.waitForURL("**/processes/workflow/**")
      await expect(
        page.getByRole("heading", {
          name: "Workflow information",
          exact: true,
        }),
      ).toBeVisible()
      const shellRequests = requests.filter((request) => {
        const headers = request.headers()
        return (
          request.url().includes("/processes/workflow/") &&
          headers["next-router-prefetch"] === "1" &&
          headers["next-router-segment-prefetch"] !== "/_tree"
        )
      })
      // Next 16.3 route discovery may be per URL; the data shell must be shared.
      expect(shellRequests).toHaveLength(1)
      expect(
        requests.filter((request) =>
          request.postData()?.includes("query FormMetadata"),
        ),
      ).toHaveLength(0)
    })
  },
)
