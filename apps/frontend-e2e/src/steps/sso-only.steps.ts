import assert from "node:assert/strict"
import { type BrowserContext, expect } from "@playwright/test"
import { Schema } from "effect"
import { ProviderUserSessionSchema } from "@pf/auth-session"
import { getEffectiveGraphqlEndpoint } from "@pf/frontend-endpoints/port-files"
import { signInWithControlledProvider } from "./controlled-sso"
import { Then, When } from "./fixtures"

async function ssoSession(context: BrowserContext, baseURL: string) {
  const cookie = (await context.cookies(baseURL)).find(
    (value) => value.name === `access_token_${new URL(baseURL).port}`,
  )
  assert.ok(cookie, "Normal SSO login must issue an access cookie")
  const encoded = cookie.value.split(".")[1]
  assert.ok(encoded)
  const payload: unknown = JSON.parse(
    Buffer.from(encoded, "base64url").toString(),
  )
  assert.ok(typeof payload === "object" && payload !== null)
  assert.ok("type" in payload && payload.type === "providerUser")
  assert.ok("properties" in payload)
  const session = Schema.decodeUnknownSync(ProviderUserSessionSchema)(
    payload.properties,
  )
  expect(session.humanSession).toBe(true)
  expect(session.authenticationMethod).toBeUndefined()
  expect(session.workload).toBeUndefined()
  expect(session.delegation).toBeUndefined()
  expect(session.sso?.provider).toBe("google")
  assert.ok(session.sso)
  expect(session.sso.expiresAt - session.sso.verifiedAt).toBe(
    8 * 60 * 60 * 1000,
  )
  // Decoding above asserts issuance provenance only. These protected requests
  // exercise the server's real signature, session and authorization checks.
  const headers = { Authorization: `Bearer ${cookie.value}` }
  const user = await context.request.post(getEffectiveGraphqlEndpoint(), {
    headers,
    data: { query: "{ currentProviderUser { email } }" },
  })
  expect(await user.json()).toEqual({
    data: { currentProviderUser: { email: session.email } },
  })
  const endpoint = new URL("/delegations", getEffectiveGraphqlEndpoint())
  const own = await context.request.get(endpoint.href, { headers })
  expect(own.status()).toBe(200)
  expect(await own.json()).toMatchObject({
    owner: { userId: session.userId, email: session.email },
    canIssue: true,
    delegations: [],
  })
  return { session, headers, endpoint }
}

Then(
  "my SSO session preserves user ownership",
  async ({ context, browser, baseURL }) => {
    assert.ok(baseURL)
    const first = await ssoSession(context, baseURL)
    expect(first.session.email).toBe("test@example.com")
    expect(first.session.sso?.subject).toBe("controlled-google-user")
    const otherContext = await browser.newContext({ baseURL })
    try {
      const otherPage = await otherContext.newPage()
      await signInWithControlledProvider(otherPage, "Continue as other user")
      const other = await ssoSession(otherContext, baseURL)
      expect(other.session.email).toBe("settings-e2e@example.com")
      expect(other.session.sso?.subject).toBe("controlled-google-other")
      expect(other.session.userId).not.toBe(first.session.userId)
      expect(new Set(other.session.roles)).toEqual(new Set(first.session.roles))
      for (const [actor, owner, client] of [
        [first, other, context],
        [other, first, otherContext],
      ] as const) {
        const endpoint = new URL(actor.endpoint)
        endpoint.searchParams.set("ownerUserId", owner.session.userId)
        const response = await client.request.get(endpoint.href, {
          headers: actor.headers,
        })
        // Administrators may inspect other owners, but do not inherit their
        // human authority to issue a secret. Equal roles do not erase ownership.
        expect(response.status()).toBe(200)
        expect(await response.json()).toMatchObject({
          owner: { userId: owner.session.userId, email: owner.session.email },
          canIssue: false,
          delegations: [],
        })
        const issuance = await client.request.post(endpoint.href, {
          headers: actor.headers,
          data: { name: "cross-owner-denied", lifetimeDays: 1 },
        })
        expect(issuance.status()).toBe(403)
        expect(await issuance.json()).toEqual({ error: "issuance_denied" })
      }
    } finally {
      await otherContext.close()
    }
  },
)

When(
  "the controlled provider returns {string}",
  async ({ page }, evidence: string) => {
    await page.goto("/processes")
    await expect(page.getByRole("button", { name: /passkey/i })).toHaveCount(0)
    await page.getByRole("button", { name: /Google/ }).click()
    await expect(
      page.getByRole("heading", { name: "Controlled Google provider" }),
    ).toBeVisible()
    await page.getByRole("button", { name: evidence, exact: true }).click()
  },
)

Then(
  "SSO rejects it with {string} and leaves no usable session",
  async ({ page, context, baseURL }, error: string) => {
    assert.ok(baseURL)
    await expect(page.locator("body")).toContainText(error)
    expect(new URL(page.url()).pathname).toBe("/oauth/google/callback")
    expect(
      (await context.cookies(baseURL)).some((cookie) =>
        /^(access|refresh)_token/.test(cookie.name),
      ),
    ).toBe(false)
    const response = await context.request.post(getEffectiveGraphqlEndpoint(), {
      data: { query: "{ currentProviderUser { id email } }" },
    })
    expect(await response.json()).toMatchObject({
      errors: [{ message: "Unauthenticated" }],
    })
    await page.goto("/processes")
    await expect(page).toHaveURL(/\/login/)
    const refresh = await context.request.post(
      new URL("/api/auth/refresh", baseURL).href,
    )
    expect(await refresh.json()).toEqual({ success: false, redirect: "/login" })
  },
)
