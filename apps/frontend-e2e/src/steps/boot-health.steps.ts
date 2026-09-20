import { expect } from "@playwright/test"
import { Then, When } from "./fixtures"

const BOOT_HEALTH_MARKER = "#frontend-boot-health"
const BOOT_HEALTH_PHASE_ATTRIBUTE = "data-frontend-boot-health"

When(
  "I open the frontend boot health page",
  async ({ page, scenarioState }) => {
    const consoleErrors: string[] = []

    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text())
      }
    })

    scenarioState.set("frontendBootHealthConsoleErrors", consoleErrors)
    await page.goto("/_pf/health")
  },
)

Then(
  "the frontend boot health marker reports {string}",
  async ({ page }, expectedPhase) => {
    await expect(page.locator(BOOT_HEALTH_MARKER)).toHaveAttribute(
      BOOT_HEALTH_PHASE_ATTRIBUTE,
      expectedPhase,
      { timeout: 30_000 },
    )
  },
)

Then(
  "the browser console records a frontend plugin boot failure",
  async ({ scenarioState }) => {
    const consoleErrors = scenarioState.get(
      "frontendBootHealthConsoleErrors",
    ) as string[] | undefined

    const reportedFailure = consoleErrors?.some(
      (text) =>
        text.includes(
          "[frontend-plugin-loaders] failed to load frontend plugin",
        ) || text.includes("[frontend-boot-health]"),
    )

    expect(reportedFailure, consoleErrors?.join("\n")).toBe(true)
  },
)

Then(
  "the frontend boot health page shows the rendered analytics plugin",
  async ({ page }) => {
    await expect(
      page.getByText(
        "analytics.boot-health-probe rendered by the organisation plugin",
      ),
    ).toBeVisible({ timeout: 30_000 })
  },
)
