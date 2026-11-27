import { execFileSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { expect } from "@playwright/test"
import { getEffectiveGraphqlEndpoint } from "@pf/frontend-endpoints/port-files"
import { dashboardAccount, dashboardRegistrationLink } from "./dashboard-user"
import { Given, Then, When } from "./fixtures"
import { createPasskeyUser } from "./passkey-user"

Then(
  "a failed post-registration logout retains a device for normal login",
  async ({ browser, page, baseURL, $testInfo }) => {
    $testInfo.setTimeout(90_000)
    if (!baseURL || !process.env["FRONTEND_E2E_DISPOSABLE_ORG"])
      throw new Error("This scenario requires the disposable runner")
    const email = "ci@example.com"
    const cached = dashboardAccount(baseURL, email)
    expect(cached.account.kind).toBe("register")
    let logoutAttempted = false
    await page.route("**/api/auth/logout", async (route) => {
      logoutAttempted = true
      await route.abort("failed")
    })
    await expect(
      createPasskeyUser(browser, {
        baseURL,
        graphqlEndpoint: getEffectiveGraphqlEndpoint(),
        workerIndex: $testInfo.workerIndex,
        page,
        account: cached.account,
        invite: dashboardRegistrationLink,
        saveCredentials: cached.save,
      }),
    ).rejects.toThrow()
    expect(logoutAttempted).toBe(true)
    const recovered = dashboardAccount(baseURL, email)
    expect(recovered.account.kind).toBe("login")
    const user = await createPasskeyUser(browser, {
      baseURL,
      graphqlEndpoint: getEffectiveGraphqlEndpoint(),
      workerIndex: $testInfo.workerIndex,
      account: recovered.account,
      saveCredentials: recovered.save,
      invite: async () => {
        throw new Error("Retry must not need another Registration Link")
      },
    })
    try {
      expect(await user.graphql("{ __typename }")).toEqual({
        data: { __typename: "Query" },
      })
    } finally {
      await user.dispose()
    }
  },
)

Given(
  "two isolated invited Passkey users have registered and signed in again",
  async ({ passkeyUser, baseURL, $testInfo }) => {
    $testInfo.setTimeout(180_000)
    const org = process.env["FRONTEND_E2E_DISPOSABLE_ORG"]
    if (!org || !baseURL || new URL(baseURL).hostname !== "localhost")
      throw new Error("This scenario requires the disposable localhost runner")
    const relativeOrg = relative(realpathSync(tmpdir()), realpathSync(org))
    if (relativeOrg.startsWith("..") || isAbsolute(relativeOrg))
      throw new Error("Only a temporary organisation may be provisioned")
    const invite = async (email: string) => {
      const cli = (...args: string[]) =>
        execFileSync(
          "bun",
          ["../../../../cli/pfcli/src/main.ts", "invitation", ...args],
          {
            cwd: __dirname,
            env: {
              ...process.env,
              SQLITE_DATABASE_PATH: join(org, "db/pf.db"),
              FRONTEND_BASE_URL: baseURL,
              NODE_ENV: "development",
            },
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          },
        )
      cli("create", org, "--email", email, "--role", "/Employee")
      const output = cli("registration-link", org, "--email", email)
      const link = output.match(
        /http:\/\/localhost:\d+\/register\/passkey#token=[A-Za-z0-9_.-]+/,
      )?.[0]
      if (!link) throw new Error("CLI did not return a Registration Link")
      return link
    }
    const options = {
      baseURL,
      graphqlEndpoint: getEffectiveGraphqlEndpoint(),
      invite,
    }
    await passkeyUser(options)
    await passkeyUser(options)
  },
)

Then(
  "each Passkey user can perform protected browser and API work",
  async ({ passkeyUsers }) => {
    for (const user of passkeyUsers) {
      // Human-only Passkey management proves this is not an impersonated user.
      await user.page.goto("/passkeys")
      await expect(
        user.page.getByRole("button", { name: "Add Passkey", exact: true }),
      ).toBeVisible()
      expect(
        await user.graphql("{ pullExecution(limit: 1) { documents { id } } }"),
      ).toMatchObject({
        data: { pullExecution: { documents: expect.any(Array) } },
      })
    }
  },
)

When(
  "the first Passkey user's session is lost",
  async ({ passkeyUsers, scenarioState }) => {
    const [first, second] = passkeyUsers
    if (!first || !second) throw new Error("Two users required")
    scenarioState.set("second-token", await second.credentials())
    await first.context.clearCookies()
  },
)

Then(
  "normal Passkey login reacquires API access without affecting the other user",
  async ({ passkeyUsers, scenarioState }) => {
    const [first, second] = passkeyUsers
    if (!first || !second) throw new Error("Two users required")
    expect(await first.graphql("{ __typename }")).toEqual({
      data: { __typename: "Query" },
    })
    // Compare booleans so failing reports cannot print bearer credentials.
    expect(
      (await second.credentials()) === scenarioState.get("second-token"),
    ).toBe(true)
    await expect(first.page.getByTestId("header-profile-button")).toContainText(
      first.email,
    )
    await expect(
      second.page.getByTestId("header-profile-button"),
    ).toContainText(second.email)
  },
)
