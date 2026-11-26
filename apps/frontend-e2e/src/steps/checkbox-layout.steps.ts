import { execFileSync } from "node:child_process"
import { resolve } from "node:path"
import { workspaceRoot } from "@nx/devkit"
import { expect } from "@playwright/test"
import { Given, Then } from "./fixtures"

let fixture: { script: string; css: string } | undefined

Given(
  "I open the shared checkbox form at {int} pixels",
  async ({ page }, width: number) => {
    fixture ??= JSON.parse(
      execFileSync(
        "bun",
        [resolve(__dirname, "../../fixtures/build-checkbox-form.mjs")],
        {
          cwd: workspaceRoot,
          encoding: "utf8",
          maxBuffer: 20 * 1024 * 1024,
        },
      ),
    )
    if (!fixture) throw new Error("Missing checkbox fixture")
    const { script, css } = fixture
    await page.setViewportSize({ width, height: 900 })
    await page.route("**/checkbox-fixture", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html><head><link rel="stylesheet" href="/checkbox-fixture.css"></head><body><div id="root"></div><script type="module" src="/checkbox-fixture.js"></script></body></html>',
      }),
    )
    await page.route("**/checkbox-fixture.js", (route) =>
      route.fulfill({ contentType: "text/javascript", body: script }),
    )
    await page.route("**/checkbox-fixture.css", (route) =>
      route.fulfill({ contentType: "text/css", body: css }),
    )
    await page.goto("/checkbox-fixture")
    await expect(
      page.getByRole("checkbox", { name: "Expected on this day" }),
    ).toBeVisible()
  },
)

Then(
  "checkbox labels sit beside compact controls and wrap naturally",
  async ({ page }) => {
    const notes = await page
      .getByRole("textbox", { name: "Notes" })
      .boundingBox()
    if (!notes) throw new Error("Notes input must be visible")
    for (const id of ["expected", "consent"]) {
      const checkbox = page.locator(`[id="${id}"]`)
      const label = page.locator(`label[for="${id}"]`)
      const control = await checkbox.boundingBox()
      const text = await label.boundingBox()
      if (!control || !text)
        throw new Error("Checkbox and label must be visible")
      expect(Math.abs(control.x - notes.x)).toBeLessThanOrEqual(1)
      expect(control.width).toBeGreaterThanOrEqual(12)
      expect(control.width).toBeLessThanOrEqual(24)
      expect(control.height).toBeGreaterThanOrEqual(12)
      expect(control.height).toBeLessThanOrEqual(24)
      expect(text.x - (control.x + control.width)).toBeGreaterThanOrEqual(4)
      expect(text.x - (control.x + control.width)).toBeLessThanOrEqual(12)
      // Compare the first text line, allowing subsequent lines to wrap beside it.
      expect(Math.abs(text.y - control.y)).toBeLessThanOrEqual(4)
      expect(text.x + text.width).toBeLessThanOrEqual(
        (page.viewportSize()?.width ?? 0) - 20,
      )
      if (id === "consent" && page.viewportSize()?.width === 320) {
        expect(text.height).toBeGreaterThan(40)
      }
    }
    const helper = await page
      .getByText("Expect this child on Fridays.")
      .boundingBox()
    const label = await page.locator('label[for="expected"]').boundingBox()
    if (!helper || !label) throw new Error("Missing description")
    expect(helper.y).toBeGreaterThanOrEqual(label.y + label.height)
    expect(
      await page
        .getByRole("textbox", { name: "Notes" })
        .evaluate((el) => el.getBoundingClientRect().width),
    ).toBeGreaterThan(200)
  },
)

Then("checkbox labels and Space toggle the checked state", async ({ page }) => {
  const checkbox = page.getByRole("checkbox", { name: "Expected on this day" })
  await expect(checkbox).not.toBeChecked()
  await page.locator('label[for="expected"]').click()
  await expect(checkbox).toBeChecked()
  await checkbox.focus()
  await page.keyboard.press("Space")
  await expect(checkbox).not.toBeChecked()
})

Then("the disabled checkbox retains its checked state", async ({ page }) => {
  const checkbox = page.getByRole("checkbox", { name: "Disabled preference" })
  await expect(checkbox).toBeDisabled()
  await expect(checkbox).toBeChecked()
  await page.locator('label[for="disabled"]').click({ force: true })
  await expect(checkbox).toBeChecked()
})
