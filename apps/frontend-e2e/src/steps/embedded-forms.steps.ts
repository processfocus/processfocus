import { expect } from "@playwright/test"
import { Then, When } from "./fixtures"

const EMBED_STEP_PATH = "/operations/calculator-demo/Enter numbers"
const EMBED_IFRAME_SELECTOR = "iframe.processfocus-embed-frame"

When(
  "I open a host page with the embedded calculator form",
  async ({ page }) => {
    await page.goto("/api/embed/test-host")
  },
)

When(
  "I open a host page with the embedded calculator form below a spacer",
  async ({ page }) => {
    await page.goto("/api/embed/test-host?spacer=before")
  },
)

Then(
  "I should see the embedded calculator form inside the iframe",
  async ({ page }) => {
    const frame = page.frameLocator(EMBED_IFRAME_SELECTOR)

    await expect(page).toHaveURL(/\/api\/embed\/test-host/, {
      timeout: 15000,
    })
    await expect(
      frame.getByRole("heading", { name: "Calculator Demo" }),
    ).toBeVisible({
      timeout: 15000,
    })
    await expect(
      frame.locator('[role="group"]', { hasText: "First number" }),
    ).toBeVisible({ timeout: 15000 })
  },
)

When(
  "I fill in the embedded calculator form with first number {string} and second number {string}",
  async ({ page }, first: string, second: string) => {
    const frame = page.frameLocator(EMBED_IFRAME_SELECTOR)

    await frame
      .locator('[role="group"]', { hasText: "Email" })
      .locator("input")
      .fill("embedded-calculator@example.com")
    await frame
      .locator('[role="group"]', { hasText: "First number" })
      .locator("input")
      .fill(first)
    await frame
      .locator('[role="group"]', { hasText: "Second number" })
      .locator("input")
      .fill(second)
  },
)

When("I submit the embedded calculator form", async ({ page }) => {
  const frame = page.frameLocator(EMBED_IFRAME_SELECTOR)
  await frame.getByRole("button", { name: "Submit" }).click()
})

Then(
  "I should see the embedded calculator thank-you state",
  async ({ page }) => {
    const frame = page.frameLocator(EMBED_IFRAME_SELECTOR)

    await expect(frame.getByText("Submitted", { exact: true })).toBeVisible({
      timeout: 20000,
    })
    await expect(
      frame.getByText(
        "Thanks. Your calculation request has been submitted without signing in.",
        { exact: true },
      ),
    ).toBeVisible({ timeout: 20000 })
  },
)

Then(
  "the host page should receive the embedded calculator lifecycle events",
  async ({ page }) => {
    await expect
      .poll(
        () =>
          page.evaluate((stepPath) => {
            const browserScope = globalThis as typeof globalThis & {
              __embedEvents?: ReadonlyArray<{
                readonly source?: string
                readonly event?: string
                readonly stepPath?: string
              }>
            }

            const events = browserScope.__embedEvents ?? []

            return ["ready", "submitted"].every((eventName) =>
              events.some(
                (event) =>
                  event.source === "processfocus-embed" &&
                  event.event === eventName &&
                  event.stepPath === stepPath,
              ),
            )
          }, EMBED_STEP_PATH),
        {
          message: "Waiting for embed lifecycle events from the iframe",
          timeout: 20000,
        },
      )
      .toBe(true)
  },
)

Then(
  "the host page should scroll to the embedded calculator success state",
  async ({ page }) => {
    await expect
      .poll(
        async () => {
          const box = await page.locator(EMBED_IFRAME_SELECTOR).boundingBox()
          if (!box) {
            return Number.POSITIVE_INFINITY
          }

          return box.y
        },
        {
          message: "Waiting for host page to scroll to the submitted embed",
          timeout: 10000,
        },
      )
      .toBeLessThan(120)
  },
)
