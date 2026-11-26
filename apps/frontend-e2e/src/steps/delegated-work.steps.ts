/// <reference lib="dom" />

import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import type { Page } from "@playwright/test"
import { expect } from "@playwright/test"
import { getEffectiveGraphqlEndpoint } from "@pf/frontend-endpoints/port-files"
import {
  fillDelegationSecret,
  requestDelegatedWork,
  requireDelegationArtifactSafety,
} from "./delegated-access-artifacts"
import { Then } from "./fixtures"

// Never let a Playwright fill error include the bearer value in its call log.
async function secretLogin(page: Page, secret: string, accepted: boolean) {
  await page.goto("/login")
  await page
    .locator("summary")
    .filter({ hasText: "Log in with a secret" })
    .click()
  let status: number | undefined
  try {
    await fillDelegationSecret(page, secret)
    const response = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/auth/delegation",
    )
    await page
      .getByRole("button", { name: "Log in with a secret", exact: true })
      .click()
    status = (await response).status()
    expect(status).toBe(accepted ? 200 : 401)
  } catch {
    const outcome = status === undefined ? "no response" : `HTTP ${status}`
    throw new Error(
      `Secret login did not produce the expected authentication outcome (${outcome})`,
    )
  } finally {
    if (await page.locator("input[type=password]").count())
      await page.locator("input[type=password]").fill("")
  }
  if (accepted) {
    await expect(page.getByTestId("header-profile-button")).toHaveAttribute(
      "aria-label",
      /acting on behalf of/,
    )
  } else {
    await expect(
      page.getByRole("alert").filter({ hasText: "Unable to log in" }),
    ).toBeVisible()
    await expect(page).toHaveURL(/\/login$/)
  }
}

const loginUrl = /\/login(?:\?|$)/

// Playwright/Chromium text, not a stable API. A revoked session can already
// be redirecting to login, so goto aborts and a navigation waiter rejects
// even when the address is already login.
const isRedirectAbort = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes("interrupted by another navigation") ||
    message.includes("net::ERR_ABORTED") ||
    message.includes("frame was detached")
  )
}

const visitUntilLogin = async (page: Page, path: string) => {
  await expect(async () => {
    if (loginUrl.test(page.url())) return
    try {
      await page.goto(path, { timeout: 5_000, waitUntil: "commit" })
    } catch (error) {
      if (!isRedirectAbort(error)) throw error
    }
    // Poll the address. waitForURL follows the aborted load and fails the
    // step before the login URL is visible.
    await expect
      .poll(() => page.url(), { intervals: [50, 100, 250], timeout: 3_000 })
      .toMatch(loginUrl)
  }).toPass({ intervals: [250, 1_000], timeout: 20_000 })
}

Then(
  "a separate delegate completes a purchase approval and loses access when I revoke its token",
  async ({ page: owner, browser, baseURL, trace, screenshot, video }) => {
    requireDelegationArtifactSafety({ trace, screenshot, video })
    const org = process.env["FRONTEND_E2E_DISPOSABLE_ORG"]
    if (!org || !baseURL)
      throw new Error("Disposable delegation runtime required")
    const name = `work-${randomUUID()}`
    await owner.locator("summary").filter({ hasText: "Create token" }).click()
    await owner.getByLabel("Name", { exact: true }).fill(name)
    await owner
      .getByRole("button", { name: "Create secret", exact: true })
      .click()
    await expect
      .poll(() =>
        owner
          .getByRole("heading", { name: "Copy your secret now" })
          .isVisible(),
      )
      .toBe(true)
    const secret = await owner.locator("code[data-private]").textContent()
    if (!secret) throw new Error("No delegation secret disclosed")
    await owner
      .getByRole("button", { name: "I have saved it", exact: true })
      .click()
    const context = await browser.newContext({ baseURL })
    const fresh = await browser.newContext({ baseURL })
    try {
      const delegate = await context.newPage()
      await secretLogin(delegate, secret, true)
      const access = (await context.cookies()).find(
        (cookie) => cookie.name === `access_token_${new URL(baseURL).port}`,
      )?.value
      if (!access) throw new Error("Delegated access cookie missing")
      const protectedWork = () =>
        requestDelegatedWork(getEffectiveGraphqlEndpoint(), access)
      expect(await protectedWork()).toMatchObject({
        data: { pullExecution: { documents: expect.any(Array) } },
      })
      await delegate.goto("/processes")
      await delegate
        .locator("article")
        .filter({
          has: delegate.getByRole("heading", {
            name: "Purchase Request",
            exact: true,
          }),
        })
        .getByRole("link", { name: "Start process", exact: true })
        .click()
      await delegate
        .getByRole("textbox", { name: "Item", exact: true })
        .fill(name)
      await delegate
        .getByRole("textbox", { name: "Value", exact: true })
        .fill("750")
      await delegate
        .getByRole("button", { name: "Submit", exact: true })
        .click()
      await expect(delegate).toHaveURL(/\/processes$/)
      await delegate.goto("/to-dos")
      const card = delegate
        .locator("article")
        .filter({ hasText: name })
        .filter({ hasText: "Approve purchase request" })
        .last()
      await expect(async () => {
        await delegate.reload()
        await expect(card).toBeVisible({ timeout: 5_000 })
      }).toPass({ timeout: 60_000 })
      const action = card.getByRole("link", { name: "Do", exact: true })
      const href = await action.getAttribute("href")
      const todoId = new URL(href ?? "", baseURL).searchParams.get("todoId")
      if (!todoId) throw new Error("Approval Todo ID missing")
      await action.click()
      await delegate.getByRole("checkbox", { name: "I approve" }).check()
      await delegate.getByRole("button", { name: "Done", exact: true }).click()
      await expect(delegate).toHaveURL(/\/to-dos$/)
      // Read the real database independently of the optimistic browser state.
      const persisted = (): unknown =>
        JSON.parse(
          execFileSync(
            "bun",
            [
              "-e",
              `
        import { Database } from "bun:sqlite";
        const db = new Database(process.argv[1], { readonly: true });
        const row = db.query("SELECT t.completed_by_user, t.updated_by, e.created_by FROM pf_to_do t JOIN pf_process_execution e ON e.id = t.process_execution_id WHERE t.id = ?").get(process.argv[2]);
        console.log(JSON.stringify(row)); db.close();
      `,
              join(org, "db/pf.db"),
              todoId,
            ],
            { encoding: "utf8" },
          ),
        )
      await expect.poll(persisted).toMatchObject({
        completed_by_user: expect.any(String),
        created_by: expect.stringContaining(`"name":"${name}"`),
        updated_by: expect.stringContaining(`"name":"${name}"`),
      })
      await delegate.reload()
      await expect(card).toHaveCount(0)
      const token = owner
        .getByRole("article")
        .filter({ has: owner.getByRole("heading", { name, exact: true }) })
      await token.getByRole("button", { name: "Revoke", exact: true }).click()
      await token
        .getByRole("button", { name: "Confirm revocation", exact: true })
        .click()
      await expect(owner.getByRole("status")).toContainText("Token revoked.")
      await expect
        .poll(protectedWork, { timeout: 60_000, intervals: [250, 1000] })
        .toMatchObject({
          errors: expect.arrayContaining([
            expect.objectContaining({
              extensions: { code: "UNAUTHENTICATED" },
            }),
          ]),
        })
      const denied = await protectedWork()
      expect(denied).not.toHaveProperty("data.pullExecution")
      // Revocation can redirect the active page while this navigation is pending.
      // The helper still requires the final login destination.
      await visitUntilLogin(delegate, "/processes")
      await secretLogin(await fresh.newPage(), secret, false)
      await expect
        .poll(persisted)
        .toMatchObject({ completed_by_user: expect.any(String) })
    } finally {
      await context.close()
      await fresh.close()
    }
  },
)
