import { expect } from "@playwright/test"
import { Then, When } from "./fixtures"

const list = "/lists/in-after-school-care"
const listState = `${list}?limit=20&sort=child&dir=asc`
const start = (action: string) =>
  `/processes/start/after-school-care-${action.toLowerCase()}/${action}?returnTo=${encodeURIComponent(listState)}`

When(
  "I open a care process while a List filter is pending",
  async ({ page }) => {
    await page.goto(listState)
    const filter = page.getByPlaceholder("Filter results...")
    await expect(filter).toBeVisible()
    await filter.fill("child")
    await page.getByRole("link", { name: "Sign-in", exact: true }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    // Observe the whole debounce window, including the resulting route request.
    await page.waitForTimeout(1_000)
    await expect(
      page.getByRole("dialog", { name: "Sign-in", exact: true }),
    ).toBeVisible()
    await expect(page).toHaveURL(/\/processes\/start\//)
    const child = dialog.getByRole("combobox", { name: "Child", exact: true })
    await expect(child).toBeFocused()
    await expect(child).toHaveAttribute("aria-expanded", "true")
    await page.keyboard.press("Escape")
    await expect(child).toHaveAttribute("aria-expanded", "false")
    await expect(child).toBeFocused()
    await expect(dialog).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
    await expect(page).toHaveURL(
      /\/lists\/in-after-school-care\?.*filter=child/,
    )
    await expect(filter).toHaveValue("child")
    await filter.clear()
    await expect(page).toHaveURL(
      new RegExp(`${list}\\?limit=20&sort=child&dir=asc&page=1$`),
    )
  },
)

When("I check both care List process dialogs", async ({ page }) => {
  await page.goto(listState)
  const background = page
    .locator("h1:visible")
    .filter({ hasText: /^In After School Care List$/ })
  // The loading fallback has the same heading but no process links. Wait for
  // the real controls before marking the node that navigation must preserve.
  await expect(
    page.getByRole("link", { name: "Sign-in", exact: true }),
  ).toBeVisible()
  await expect(background).toBeVisible()
  // A browser-owned property detects replacement of the actual List DOM node.
  await background.evaluate((node) =>
    node.setAttribute("data-retained-list", "true"),
  )
  for (const action of ["Sign-in", "Sign-out"]) {
    const trigger = page.getByRole("link", { name: action, exact: true })
    await trigger.click()
    const dialog = page.getByRole("dialog", { name: action, exact: true })
    await expect(dialog).toBeVisible()
    await expect(background).toBeVisible()
    await expect(background).toHaveAttribute("data-retained-list", "true")
    await expect(dialog.getByRole("combobox").first()).toBeVisible()
    const child = dialog.getByRole("combobox", { name: "Child", exact: true })
    await expect(child).toBeFocused()
    await expect(child).toHaveAttribute("aria-expanded", "true")
    await page.keyboard.press("Escape")
    await expect(child).toHaveAttribute("aria-expanded", "false")
    await expect(child).toBeFocused()
    await expect(dialog).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
    await expect(page).toHaveURL(
      new RegExp(`${list}\\?limit=20&sort=child&dir=asc$`),
    )
    await expect(trigger).toBeFocused()
    await page.goForward()
    await expect(dialog).toBeVisible()
    await page.goBack()
    await expect(dialog).toHaveCount(0)
    await expect(background).toHaveAttribute("data-retained-list", "true")
  }
})

Then(
  "direct care process URLs also retain the List background",
  async ({ page }) => {
    // Keep a plain URL case and enforce first-value semantics for repeated params.
    for (const { action, url } of [
      { action: "Sign-in", url: start("Sign-in") },
      {
        action: "Sign-out",
        url: `${start("Sign-out")}&returnTo=%2Flists%2Fterms`,
      },
    ]) {
      await page.goto(url)
      const dialog = page.getByRole("dialog", { name: action, exact: true })
      await expect(dialog).toBeVisible()
      await expect(
        page
          .locator("h1:visible")
          .filter({ hasText: /^In After School Care List$/ }),
      ).toBeVisible()
      // Replay CI's lookup failure while Close is pressed: the Retry control
      // increases the centered dialog's height and moves its header.
      const lookupRelease = Promise.withResolvers<void>()
      if (action === "Sign-in")
        await page.route("**/graphql", async (route) => {
          if (!route.request().postData()?.includes("lookupSearch")) {
            await route.continue()
            return
          }
          await lookupRelease.promise
          await route.fulfill({
            json: {
              errors: [{ message: "Couldn't load choices" }],
              data: null,
            },
          })
        })
      await page.reload()
      await expect(dialog).toBeVisible()
      await expect(
        dialog.getByRole("combobox", { name: "Child", exact: true }),
      ).toBeFocused()
      const close = dialog.getByRole("button", { name: "Close", exact: true })
      if (action === "Sign-in") {
        await close.hover()
        await page.mouse.down()
        lookupRelease.resolve()
        await expect(
          dialog.getByRole("button", { name: "Retry" }),
        ).toBeVisible()
        await page.mouse.up()
      } else {
        await close.click({ delay: 100 })
      }
      await expect(dialog).toHaveCount(0)
      await page.unroute("**/graphql")
      await expect(page).toHaveURL(
        new RegExp(`${list}\\?limit=20&sort=child&dir=asc$`),
      )
      await page.getByRole("link", { name: action, exact: true }).click()
      await expect(dialog).toBeVisible()
      await dialog.getByRole("button", { name: "Discard", exact: true }).click()
      await expect(dialog).toHaveCount(0)
    }
    await page
      .getByRole("link", {
        name: "Terms View and maintain the school term dates",
      })
      .click()
    await expect(
      page.getByRole("heading", { name: "Terms", exact: true }),
    ).toBeVisible()
    await expect(page.getByRole("dialog")).toHaveCount(0)
  },
)
