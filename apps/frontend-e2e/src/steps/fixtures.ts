import { instant } from "@next/playwright"
import { type Page, chromium } from "@playwright/test"
import { test as base, createBdd } from "playwright-bdd"
import { getEffectiveGraphqlEndpoint } from "@pf/frontend-endpoints/port-files"
import { withRegularRuntime } from "../../scripts/regular-worker"
import { dashboardAccount, dashboardRegistrationLink } from "./dashboard-user"
import {
  type PasskeyUser,
  type PasskeyUserOptions,
  createPasskeyUser,
} from "./passkey-user"

export const appDialog = (page: Page) =>
  page.locator('[role="dialog"]:not([data-nextjs-dialog])')

/**
 * Named Provider User persona. Roles are selected explicitly in the UI by
 * role-switch journeys; authentication itself uses the user's default roles.
 */
type AuthenticateAsProviderUser = (
  email: string,
  roles?: string[],
  clientId?: string,
) => Promise<void>

interface TestFixtures {
  passkeyUsers: PasskeyUser[]
  passkeyUser: (
    options: Omit<PasskeyUserOptions, "workerIndex">,
  ) => Promise<PasskeyUser>
  instantUI: (assertUI: () => Promise<void>) => Promise<void>
  authenticateAsProviderUser: AuthenticateAsProviderUser
  restoreProviderRoles: Array<() => Promise<void>>
  scenarioState: Map<string, unknown>
}

export const test = base.extend<
  TestFixtures,
  { regularOrigin: string | undefined }
>({
  regularOrigin: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture requires destructuring
    async ({}, use) => {
      if (process.env["FRONTEND_E2E_ISOLATED_WORKERS"] === "1")
        await withRegularRuntime(use)
      else await use(undefined)
    },
    { scope: "worker", timeout: 120_000 },
  ],
  ...(process.env["FRONTEND_E2E_ISOLATED_WORKERS"] === "1"
    ? { baseURL: async ({ regularOrigin }, use) => use(regularOrigin) }
    : {}),
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture requires destructuring
  passkeyUsers: async ({}, use) => {
    await use([])
  },
  passkeyUser: async ({ browser, passkeyUsers }, use, testInfo) => {
    try {
      await use(async (options) => {
        const user = await createPasskeyUser(browser, {
          ...options,
          workerIndex: testInfo.workerIndex,
        })
        passkeyUsers.push(user)
        return user
      })
    } finally {
      await Promise.all(passkeyUsers.map((user) => user.dispose()))
    }
  },
  instantUI: async ({ page, baseURL }, use) => {
    if (process.env["PF_INSTANT_E2E"] !== "1") {
      throw new Error(
        "instantUI requires PF_INSTANT_E2E=1 and a production test build",
      )
    }
    await use((assertUI) =>
      instant(page, assertUI, baseURL ? { baseURL } : undefined),
    )
  },
  // biome-ignore lint/correctness/noEmptyPattern: playwright-bdd fixture requires destructuring pattern
  scenarioState: async ({}, use) => {
    await use(new Map())
  },

  // Named policy personas share a serial runtime, but each scenario signs in
  // anew and restores role mutations before the next scenario can use it.
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture requires destructuring
  restoreProviderRoles: async ({}, use) => {
    const restore: Array<() => Promise<void>> = []
    try {
      await use(restore)
    } finally {
      for (const operation of restore.reverse()) await operation()
    }
  },
  authenticateAsProviderUser: async (
    { browser, page, baseURL, restoreProviderRoles, regularOrigin },
    use,
    testInfo,
  ) => {
    if (!baseURL) throw new Error("Dashboard origin required")
    if (testInfo.config.workers !== 1 && baseURL !== regularOrigin)
      throw new Error(
        "Named Dashboard policy personas require one worker per runtime",
      )
    // Request the fixture dependency so restoration runs even on scenario failure.
    void restoreProviderRoles
    // Virtual WebAuthn is Chromium-only. Other browser projects exercise the
    // business surface with cookies issued by the same real login ceremony.
    const authenticationBrowser =
      browser.browserType().name() === "chromium"
        ? browser
        : await chromium.launch()
    const copySession = async () => {
      if (authenticationBrowser === browser || !active) return
      await page.context().clearCookies()
      await page.context().addCookies(await active.context.cookies(baseURL))
      await page.goto("/")
    }
    let active: PasskeyUser | undefined
    const release = async () => {
      if (!active) return
      const user = active
      active = undefined
      await user.dispose()
    }
    try {
      await use(async (email) => {
        if (active?.email === email) {
          if (authenticationBrowser !== browser)
            await active.context.clearCookies()
          await active.login()
          await copySession()
          return
        }
        await release()
        const cached = dashboardAccount(baseURL, email)
        active = await createPasskeyUser(authenticationBrowser, {
          baseURL,
          graphqlEndpoint:
            process.env["GRAPHQL_ENDPOINT"] ?? getEffectiveGraphqlEndpoint(),
          workerIndex: testInfo.workerIndex,
          ...(authenticationBrowser === browser ? { page } : {}),
          account: cached.account,
          invite: dashboardRegistrationLink,
          saveCredentials: cached.save,
        })
        cached.save(await active.virtualCredentials())
        await copySession()
      })
    } finally {
      try {
        await release()
      } finally {
        if (authenticationBrowser !== browser)
          await authenticationBrowser.close()
      }
    }
  },
})

export const { Given, When, Then } = createBdd(test)
