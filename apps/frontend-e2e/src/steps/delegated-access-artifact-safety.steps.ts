/// <reference lib="dom" />

import { createServer } from "node:net"
import { expect } from "@playwright/test"
import {
  checkAndDismissDelegationSecret,
  delegationArtifactOptions,
  fillDelegationSecret,
  requestDelegatedWork,
  requireDelegationArtifactSafety,
} from "./delegated-access-artifacts"
import { Given } from "./fixtures"

Given(
  "I force a failure after verifying secret-safe clipboard cleanup",
  async ({ page, context, trace, screenshot, video }) => {
    requireDelegationArtifactSafety({ trace, screenshot, video })
    for (const option of ["trace", "screenshot", "video"] as const) {
      expect(() =>
        requireDelegationArtifactSafety({
          ...delegationArtifactOptions,
          [option]: "on",
        }),
      ).toThrow("secret-safe artifact settings")
    }
    const canary = process.env["FRONTEND_E2E_ARTIFACT_CANARY"]
    if (!canary) throw new Error("Run the artifact-safety verification script")
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: "http://localhost:3198",
    })
    await page.route("http://localhost:3198/artifact-safety", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<input type="password"><label>Name<input id="delegation-name" value="probe-name"></label><section><h2>Copy your secret now</h2><code data-private></code><button id="copy">Copy secret</button><button id="dismiss">I have saved it</button></section><p role="status"></p>',
      }),
    )
    await page.goto("http://localhost:3198/artifact-safety")
    await page.evaluate((secret) => {
      const code = document.querySelector("code")
      const copy = document.querySelector("#copy")
      const dismiss = document.querySelector("#dismiss")
      if (!code || !copy || !dismiss) throw new Error("Missing probe controls")
      code.textContent = secret
      copy.addEventListener("click", async () => {
        await navigator.clipboard.writeText("deliberately-wrong-value")
        const status = document.querySelector('[role="status"]')
        if (status) status.textContent = "Secret copied."
      })
      dismiss.addEventListener("click", () =>
        document.querySelector("section")?.remove(),
      )
    }, canary)
    await fillDelegationSecret(page, canary)
    expect(
      await page
        .locator("input[type=password]")
        .evaluate(
          (element, secret) =>
            element instanceof HTMLInputElement && element.value === secret,
          canary,
        ),
    ).toBe(true)
    let comparisonFailed = false
    try {
      await checkAndDismissDelegationSecret(page)
    } catch (error) {
      expect(error).toMatchObject({
        matcherResult: { actual: false, expected: true },
      })
      comparisonFailed = true
    }
    expect(comparisonFailed).toBe(true)
    expect(
      await page.evaluate(
        async () => (await navigator.clipboard.readText()) === "",
      ),
    ).toBe(true)
    await expect(page.locator("code[data-private]")).toHaveCount(0)
    await expect(page.getByLabel("Name")).toHaveValue("probe-name")
    // Leave a synthetic secret visible at failure to test artifact suppression, not just cleanup.
    await page.evaluate((secret) => {
      document.body.textContent = secret
    }, canary)
    throw new Error("Intentional secret-safe artifact probe failure")
  },
)

Given(
  "a delegated protected-work request fails during transport",
  async ({ trace, screenshot, video }) => {
    requireDelegationArtifactSafety({ trace, screenshot, video })
    const canary = process.env["FRONTEND_E2E_ARTIFACT_CANARY"]
    if (!canary) throw new Error("Run the artifact-safety verification script")
    // A real TCP peer disconnects before responding; no auth service is needed.
    const server = createServer((socket) => socket.destroy())
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const address = server.address()
      if (!address || typeof address === "string")
        throw new Error("Artifact probe TCP address missing")
      await requestDelegatedWork(
        `http://127.0.0.1:${address.port}/graphql`,
        canary,
      )
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  },
)
