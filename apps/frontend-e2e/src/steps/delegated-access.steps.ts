/// <reference lib="dom" />

import { execFileSync } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { expect } from "@playwright/test"
import { getEffectiveAuthUrl } from "@pf/frontend-endpoints/port-files"
import {
  checkAndDismissDelegationSecret,
  requireDelegationArtifactSafety,
} from "./delegated-access-artifacts"
import { Given, Then, When } from "./fixtures"

const invitationEmail =
  process.env["FRONTEND_E2E_INVITATION_EMAIL"] ?? "settings-e2e@example.com"
const ordinaryEmail = "employee-2@example.com"

Given(
  "I register a real virtual passkey in the disposable delegation organisation",
  async ({ page, context, baseURL, trace, screenshot, video }) => {
    requireDelegationArtifactSafety({ trace, screenshot, video })
    const org = process.env["FRONTEND_E2E_DISPOSABLE_ORG"]
    if (!org || !baseURL || new URL(baseURL).hostname !== "localhost") {
      throw new Error(
        "This journey requires a localhost BASE_URL and FRONTEND_E2E_DISPOSABLE_ORG pointing to its imported temporary organisation.",
      )
    }
    const relativeOrg = relative(realpathSync(tmpdir()), realpathSync(org))
    if (relativeOrg.startsWith("..") || isAbsolute(relativeOrg)) {
      throw new Error(
        "The delegation journey only mutates a temporary organisation",
      )
    }
    const databasePath = join(org, "db/pf.db")
    if (!existsSync(databasePath))
      throw new Error("Import the disposable organisation first")
    const cdp = await context.newCDPSession(page)
    await cdp.send("WebAuthn.enable")
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        ctap2Version: "ctap2_1",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    })
    // Use the supported Invitation bootstrap, never M2M session cookies.
    const output = execFileSync(
      "bun",
      [
        "../../../../cli/pfcli/src/main.ts",
        "invitation",
        "registration-link",
        org,
        "--email",
        invitationEmail,
      ],
      {
        cwd: __dirname,
        env: {
          ...process.env,
          SQLITE_DATABASE_PATH: databasePath,
          FRONTEND_BASE_URL: baseURL,
          NODE_ENV: "development",
        },
        encoding: "utf8",
      },
    )
    const registrationUrl = output.match(
      /http:\/\/localhost:\d+\/register\/passkey#token=[A-Za-z0-9_.-]+/,
    )?.[0]
    if (!registrationUrl)
      throw new Error("CLI did not return a Registration Link")
    try {
      await page.goto(registrationUrl)
    } catch {
      // Navigation errors otherwise embed the bearer Registration Link in reports.
      throw new Error("Invitation registration navigation failed")
    }
    await page
      .getByRole("button", { name: "Create passkey", exact: true })
      .click()
    await expect(page.getByTestId("header-profile-button")).toBeVisible({
      timeout: 15_000,
    })
  },
)

When("I open Act on behalf from my profile menu", async ({ page }) => {
  await expect(
    page.getByRole("button", { name: /^Current theme:/ }),
  ).toBeVisible()
  await page.getByTestId("header-profile-button").click()
  await page.getByRole("menuitem", { name: "Act on behalf" }).click()
  await expect(
    page.getByRole("heading", { name: "Act on behalf tokens", exact: true }),
  ).toBeVisible()
})

When(
  "I create and replace delegation secrets without reauthentication on desktop and mobile",
  async ({ page, context, trace, screenshot, video }) => {
    requireDelegationArtifactSafety({ trace, screenshot, video })
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(page.url()).origin,
    })
    let ceremonies = 0
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/auth/passkey/auth-options")
        ceremonies += 1
    })
    for (const days of [1, 7, 14]) {
      await page.setViewportSize(
        days === 14
          ? { width: 393, height: 851 }
          : { width: 1440, height: 1000 },
      )
      await expect(page.locator("#reauth-heading")).toHaveCount(0)
      await page.locator("summary").filter({ hasText: "Create token" }).click()
      await page.getByLabel("Name", { exact: true }).fill(`browser-${days}-day`)
      await page
        .getByRole("radio", {
          name: `${days} ${days === 1 ? "day" : "days"}`,
          exact: true,
        })
        .check()
      await page
        .getByRole("button", { name: "Create secret", exact: true })
        .click()
      await checkAndDismissDelegationSecret(page)
      // The authenticated human session is enough for the organisation grant;
      // issuance and replacement must not start another verification ceremony.
      expect(ceremonies).toBe(0)
      const record = page.getByRole("article").filter({
        has: page.getByRole("heading", {
          name: `browser-${days}-day`,
          exact: true,
        }),
      })
      await expect(record).toContainText("Never used")
      await expect(record).toContainText("Active")
      const created = await record
        .locator("div")
        .filter({ has: page.locator("dt", { hasText: /^Created$/ }) })
        .locator("dd time")
        .getAttribute("datetime")
      const expires = await record
        .locator("div")
        .filter({ has: page.locator("dt", { hasText: /^Secret expires$/ }) })
        .locator("dd time")
        .getAttribute("datetime")
      expect(Date.parse(expires ?? "") - Date.parse(created ?? "")).toBe(
        days * 86_400_000,
      )
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true)
      await record
        .getByRole("button", { name: "Regenerate", exact: true })
        .click()
      await record
        .getByRole("radio", {
          name: `${days} ${days === 1 ? "day" : "days"}`,
          exact: true,
        })
        .check()
      await record
        .getByRole("button", { name: "Regenerate secret", exact: true })
        .click()
      await checkAndDismissDelegationSecret(page)
      expect(ceremonies).toBe(0)
    }
  },
)

Then(
  "my delegation records survive a reload without revealing their secrets",
  async ({ page }) => {
    await page.reload()
    for (const days of [1, 7, 14]) {
      await expect(
        page.getByRole("heading", { name: `browser-${days}-day`, exact: true }),
      ).toBeVisible()
    }
    await expect(page.locator("code[data-private]")).toHaveCount(0)
    await expect(
      page.getByRole("button", { name: "Copy secret", exact: true }),
    ).toHaveCount(0)
  },
)

Then(
  "an ordinary human has no token-management entry and direct API access is denied",
  async ({ page, context, baseURL }) => {
    const org = process.env["FRONTEND_E2E_DISPOSABLE_ORG"]
    if (!org || !baseURL || new URL(baseURL).hostname !== "localhost")
      throw new Error(
        "This journey requires a localhost BASE_URL and disposable organisation.",
      )
    await context.clearCookies()
    const output = execFileSync(
      "bun",
      [
        "../../../../cli/pfcli/src/main.ts",
        "invitation",
        "registration-link",
        org,
        "--email",
        ordinaryEmail,
      ],
      {
        cwd: __dirname,
        env: {
          ...process.env,
          SQLITE_DATABASE_PATH: join(org, "db/pf.db"),
          FRONTEND_BASE_URL: baseURL,
          NODE_ENV: "development",
        },
        encoding: "utf8",
      },
    )
    const registrationUrl = output.match(
      /http:\/\/localhost:\d+\/register\/passkey#token=[A-Za-z0-9_.-]+/,
    )?.[0]
    if (!registrationUrl)
      throw new Error("CLI did not return an ordinary-user Registration Link")
    try {
      await page.goto(registrationUrl)
    } catch {
      throw new Error("Ordinary-user registration navigation failed")
    }
    await page
      .getByRole("button", { name: "Create passkey", exact: true })
      .click()
    const profile = page.getByTestId("header-profile-button")
    await expect(profile).toBeVisible({ timeout: 15_000 })
    await profile.click()
    await expect(
      page.getByRole("menuitem", { name: "Act on behalf" }),
    ).toHaveCount(0)

    const base = new URL(baseURL)
    const accessCookie = (await context.cookies()).find(
      (cookie) => cookie.name === `access_token_${base.port}`,
    )
    if (!accessCookie) throw new Error("Ordinary-user access cookie is missing")
    const authorization = { Authorization: `Bearer ${accessCookie.value}` }
    const list = await context.request.get(
      `${getEffectiveAuthUrl()}/delegations`,
      { headers: authorization },
    )
    expect(list.status()).toBe(403)
    const create = await context.request.post(
      `${getEffectiveAuthUrl()}/delegations`,
      {
        headers: authorization,
        data: { name: "unauthorized-browser-token", lifetimeDays: 1 },
      },
    )
    expect(create.status()).toBe(403)

    await page.goto(`${baseURL}/act-on-behalf`)
    await expect(
      page.getByRole("alert").filter({ hasText: "not permitted to inspect" }),
    ).toBeVisible()
    await expect(page.locator("summary")).toHaveCount(0)
  },
)
