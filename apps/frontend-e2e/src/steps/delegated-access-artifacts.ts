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
    await expect(
      page.getByRole("heading", { name: "Copy your secret now" }),
    ).toBeVisible()
    await page.getByRole("button", { name: "Copy secret", exact: true }).click()
    await expect(page.getByRole("status")).toHaveText("Secret copied.")
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
