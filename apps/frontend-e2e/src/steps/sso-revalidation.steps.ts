import { type Request, expect } from "@playwright/test"
import { signInWithControlledProvider } from "./controlled-sso"
import { Given, Then, When, test } from "./fixtures"

const deepLink = "/processes?view=all&label=Sales%20%26%20Support"
const controlledProvider = `http://127.0.0.1:${process.env["SSO_PROVIDER_PORT"] ?? 4599}`
const isUpstreamAuthorization = (request: Request) =>
  request.url().startsWith(`${controlledProvider}/authorize?`)

const isDeepLink = (url: URL) =>
  url.pathname === "/processes" &&
  url.searchParams.toString() === "view=all&label=Sales+%26+Support"

function expectSilentAuthorization(request: Request): void {
  const params = new URL(request.url()).searchParams
  expect(request.isNavigationRequest()).toBe(true)
  expect(params.get("prompt")).toBe("none")
  expect(params.get("login_hint")).toBe("controlled-google-user")
}

Given("I sign in through the controlled Google provider", async ({ page }) => {
  test.setTimeout(180_000)
  await signInWithControlledProvider(page)
})

When(
  "I stay on a protected deep link until Google revalidation",
  async ({ page }) => {
    await page.goto(deepLink)
    const committedPaths: string[] = []
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame())
        committedPaths.push(new URL(frame.url()).pathname)
    })
    const [upstream] = await Promise.all([
      page.waitForRequest(isUpstreamAuthorization, { timeout: 75_000 }),
      page.waitForEvent("framenavigated", {
        predicate: (frame) =>
          frame === page.mainFrame() && isDeepLink(new URL(frame.url())),
        timeout: 80_000,
      }),
    ])
    expectSilentAuthorization(upstream)
    expect(committedPaths).toEqual(["/processes"])
  },
)

Then("I am signed in on the same deep link", async ({ page }) => {
  expect(isDeepLink(new URL(page.url()))).toBe(true)
  await expect(
    page.getByRole("heading", { name: "Processes", exact: true }),
  ).toBeVisible()
})

When(
  "I reopen a protected deep link after expiry and Google returns {string}",
  async ({ page }, result: string) => {
    await page.context().addCookies([
      {
        name: "controlled_sso_revalidation",
        value: result,
        url: controlledProvider,
      },
    ])
    const dashboard = page.url()
    const dashboardCookies = () => page.context().cookies(dashboard)
    const isRefreshToken = (name: string) => /^refresh_token(?:_|$)/.test(name)
    const refresh = (await dashboardCookies()).find(({ name }) =>
      isRefreshToken(name),
    )
    if (!refresh || refresh.expires <= 0)
      throw new Error("Expected a bounded refresh cookie")
    await page.goto("about:blank")
    // The issuer rounds the cookie lifetime down to seconds. Wait past the
    // SSO deadline, not just until the browser discards the credentials.
    await expect
      .poll(
        async () =>
          Date.now() / 1000 >= refresh.expires + 1 &&
          !(await dashboardCookies()).some(({ name }) =>
            /^(access|refresh)_token(?:_|$)/.test(name),
          ),
        { timeout: 75_000 },
      )
      .toBe(true)
    const upstream: Request[] = []
    page.on("request", (request) => {
      if (isUpstreamAuthorization(request)) upstream.push(request)
    })
    await page.goto(deepLink)
    const [attempt] = upstream
    expect(
      upstream,
      `Expected a Google request before reaching ${page.url()}`,
    ).toHaveLength(1)
    if (!attempt) throw new Error("Expected a Google revalidation")
    expectSilentAuthorization(attempt)
    expect(new URL(page.url()).searchParams.get("error")).toBe(
      result === "deny" ? "auth_failed" : null,
    )
  },
)

Then(
  "Sign In preserves the deep link without retrying Google automatically",
  async ({ page }) => {
    const googleButton = page.getByRole("button", { name: /Google/ })
    const login = new URL(page.url())
    const destination = login.searchParams.get("redirect")
    expect(destination && isDeepLink(new URL(destination, login))).toBe(true)
    await expect(googleButton).toBeVisible()
    const upstream: Request[] = []
    page.on("request", (request) => {
      if (isUpstreamAuthorization(request)) upstream.push(request)
    })
    await page.goto(deepLink)
    await expect(googleButton).toBeVisible()
    expect(upstream).toHaveLength(0)
    await googleButton.click()
    await expect(
      page.getByRole("heading", { name: "Controlled Google provider" }),
    ).toBeVisible()
    expect(upstream).toHaveLength(1)
    const [interactive] = upstream
    if (!interactive) throw new Error("Expected an interactive Google request")
    expect(new URL(interactive.url()).searchParams.get("prompt")).toBeNull()
    await page.getByRole("button", { name: "Continue as test user" }).click()
    await expect(page).toHaveURL(isDeepLink)
  },
)
