/// <reference lib="dom" />

import {
  type Page,
  type PlaywrightWorkerOptions,
  expect,
} from "@playwright/test"

export const delegationArtifactOptions = {
  trace: "off",
  screenshot: "off",
  video: "off",
} satisfies Pick<PlaywrightWorkerOptions, "trace" | "screenshot" | "video">

export function requireDelegationArtifactSafety(
  options: Pick<PlaywrightWorkerOptions, "trace" | "screenshot" | "video">,
): void {
  if (
    process.env["PLAYWRIGHT_NO_COPY_PROMPT"] !== "1" ||
    options.trace !== "off" ||
    options.screenshot !== "off" ||
    options.video !== "off"
  ) {
    throw new Error("Delegation journeys require secret-safe artifact settings")
  }
}

export async function checkAndDismissDelegationSecret(
  page: Page,
): Promise<void> {
  try {
    // Locator matcher failures now include DOM snapshots independently of
    // PLAYWRIGHT_NO_COPY_PROMPT. Poll booleans/text while a secret is visible.
    await expect
      .poll(() =>
        page.getByRole("heading", { name: "Copy your secret now" }).isVisible(),
      )
      .toBe(true)
    await page.getByRole("button", { name: "Copy secret", exact: true }).click()
    await expect
      .poll(() => page.getByRole("status").textContent())
      .toBe("Secret copied.")
    // Only a boolean crosses the browser boundary; never paste into an unmasked field.
    expect(
      await page.evaluate(async () => {
        const secret = document.querySelector("code[data-private]")?.textContent
        return !!secret && (await navigator.clipboard.readText()) === secret
      }),
    ).toBe(true)
  } finally {
    try {
      await page.evaluate(() => navigator.clipboard.writeText(""))
    } finally {
      await page
        .getByRole("button", { name: "I have saved it", exact: true })
        .click()
    }
  }
}

// Locator.fill records its value in Playwright's step log. Evaluation keeps the
// bearer argument out of reports while dispatching the real form input events.
export async function fillDelegationSecret(
  page: Page,
  secret: string,
): Promise<void> {
  await page.locator("input[type=password]").evaluate((element, value) => {
    if (!(element instanceof HTMLInputElement))
      throw new Error("Secret input missing")
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set
    setter?.call(element, value)
    element.dispatchEvent(new Event("input", { bubbles: true }))
    element.dispatchEvent(new Event("change", { bubbles: true }))
  }, secret)
}

// Playwright request failures record Authorization headers in reporter call logs.
// Keep this credential-bearing request outside that instrumentation.
export async function requestDelegatedWork(endpoint: string, access: string) {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: "query { pullExecution(limit: 10) { documents { id } } }",
      }),
      signal: AbortSignal.timeout(30_000),
    })
    const body: unknown = await response.json()
    return body
  } catch {
    throw new Error("Delegated protected-work request failed")
  }
}
