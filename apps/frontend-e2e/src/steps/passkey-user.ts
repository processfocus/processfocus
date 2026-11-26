/// <reference lib="dom" />

import { randomUUID } from "node:crypto"
import { type Browser, type Page, expect } from "@playwright/test"
import { Schema } from "effect"
import { addVirtualPasskeyAuthenticator } from "./virtual-authenticator"

export const VirtualCredential = Schema.Struct({
  credentialId: Schema.String,
  isResidentCredential: Schema.Boolean,
  rpId: Schema.String,
  privateKey: Schema.String,
  userHandle: Schema.String,
  signCount: Schema.Number,
})
export type VirtualCredential = typeof VirtualCredential.Type

export interface PasskeyUserOptions {
  /** Exact frontend origin for this organisation/environment. */
  baseURL: string
  graphqlEndpoint: string
  workerIndex: number
  /** Provision an Invitation, returning its normal Registration Link. */
  invite: (email: string) => Promise<string>
  /** Named personas retain email-bound ownership/policy assertions. */
  account?:
    | { kind: "register"; email: string }
    | {
        kind: "login"
        email: string
        credentials: readonly VirtualCredential[]
      }
  /** Business BDD journeys keep Playwright's scenario-owned page/context. */
  page?: Page
  /** Let the tested surface sign in itself after provisioning the device. */
  provisionOnly?: boolean
  /** Retain registered devices even if later readiness or login fails. */
  saveCredentials?: (credentials: readonly VirtualCredential[]) => void
}

/**
 * One identity, browser context and authenticator per lease. No global or disk
 * session cache: mutable scenarios never borrow another scenario's identity.
 * The caller owns disposal (the BDD fixture does this automatically).
 */
export async function createPasskeyUser(
  browser: Browser,
  options: PasskeyUserOptions,
) {
  const origin = new URL(options.baseURL).origin
  const email =
    options.account?.email ??
    `passkey-w${options.workerIndex}-${randomUUID()}@example.test`
  const context =
    options.page?.context() ?? (await browser.newContext({ baseURL: origin }))
  context.setDefaultTimeout(30_000)
  context.setDefaultNavigationTimeout(30_000)
  let retainDevice: (() => Promise<void>) | undefined
  try {
    const page = options.page ?? (await context.newPage())
    const cdp = await context.newCDPSession(page)
    await cdp.send("WebAuthn.enable")
    const authenticatorId = await addVirtualPasskeyAuthenticator(cdp)
    const virtualCredentials = async () => {
      const result: unknown = await cdp.send("WebAuthn.getCredentials", {
        authenticatorId,
      })
      return Schema.decodeUnknownSync(
        Schema.Struct({ credentials: Schema.Array(VirtualCredential) }),
      )(result).credentials
    }
    retainDevice = async () => {
      const credentials = await virtualCredentials()
      if (credentials.length > 0) options.saveCredentials?.(credentials)
    }
    // Check the organisation's real login policy before provisioning anything.
    await page.goto("/login")
    await expect(
      page.getByRole("button", { name: "Sign in with Passkey", exact: true }),
    ).toBeVisible()
    if (options.account?.kind === "login") {
      for (const credential of options.account.credentials)
        await cdp.send("WebAuthn.addCredential", {
          authenticatorId,
          credential,
        })
    } else {
      const registrationUrl = await options.invite(email)
      if (new URL(registrationUrl).origin !== origin)
        throw new Error("Registration Link belongs to another environment")
      try {
        // Keep the bearer URL out of Playwright navigation step titles.
        await page.evaluate((url) => {
          window.location.href = url
        }, registrationUrl)
      } catch {
        throw new Error("Passkey Registration Link navigation failed")
      }
      await page
        .getByRole("button", { name: "Create passkey", exact: true })
        .click()
    }
    const url = new URL(origin)
    const suffix =
      ["localhost", "127.0.0.1"].includes(url.hostname) && url.port
        ? `_${url.port}`
        : ""
    const accessToken = async () =>
      (await context.cookies(origin)).find(
        (cookie) => cookie.name === `access_token${suffix}`,
      )?.value
    const ready = async () => {
      // This client-only control is the existing delegated journey's hydration
      // milestone; the profile button alone can still be inert server HTML.
      await expect(
        page.getByRole("button", { name: /^Current theme:/ }),
      ).toBeVisible({ timeout: 30_000 })
      await expect(page.getByTestId("header-profile-button")).toBeVisible({
        timeout: 30_000,
      })
      // The profile button shows the display name, which need not be the email.
      await page.getByTestId("header-profile-button").click()
      const identity = page.getByRole("menuitem", {
        name: `Copy email address: ${email}`,
        exact: true,
      })
      await expect(identity).toBeVisible()
      await page.keyboard.press("Escape")
      await expect(identity).not.toBeVisible()
    }
    const logout = async () => {
      await page.getByTestId("header-profile-button").click()
      await page.getByTestId("header-logout-button").click()
      await expect(page).toHaveURL(/\/login(?:\?|$)/)
    }
    const signIn = async () => {
      await page
        .getByRole("button", { name: "Sign in with Passkey", exact: true })
        .click()
      await ready()
    }
    const login = async () => {
      // A protected page may already be redirecting after session loss. Retry
      // that navigation boundary rather than letting ERR_ABORTED prevent login.
      await expect(async () => {
        await page.goto("/login")
        await expect(
          page.getByRole("button", {
            name: "Sign in with Passkey",
            exact: true,
          }),
        ).toBeVisible()
      }).toPass({ timeout: 30_000 })
      await signIn()
    }
    if (options.provisionOnly) {
      if (options.account?.kind !== "login") {
        // Registration must finish, but MCP does not need the Dashboard to
        // hydrate. Its own authorization flow will perform a fresh sign-in.
        await expect
          .poll(async () => Boolean(await accessToken()), {
            timeout: 30_000,
            message: "Passkey registration establishes a Dashboard session",
          })
          .toBe(true)
        await page.waitForURL(`${origin}/`, { waitUntil: "commit" })
        await context.clearCookies()
      }
    } else {
      // Registration's initial session is not the reusable login fixture.
      if (options.account?.kind !== "login") {
        await ready()
        await logout()
        await login()
      } else {
        // Already on the real login page from the policy check above.
        await signIn()
      }
    }
    const request = async (
      token: string,
      query: string,
      variables: Record<string, unknown>,
    ): Promise<unknown> => {
      // fetch avoids reporter call logs containing Authorization headers.
      const response = await fetch(options.graphqlEndpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30_000),
      })
      return response.json()
    }
    const authenticated = (body: unknown) =>
      typeof body === "object" &&
      body !== null &&
      "data" in body &&
      typeof body.data === "object" &&
      body.data !== null &&
      "__typename" in body.data &&
      body.data.__typename === "Query"
    const credentials = async () => {
      const token = await accessToken()
      if (token && authenticated(await request(token, "{ __typename }", {})))
        return token
      // Missing/expired/revoked sessions use a real ceremony, never cookie edits.
      await context.clearCookies()
      await login()
      const renewed = await accessToken()
      if (
        !renewed ||
        !authenticated(await request(renewed, "{ __typename }", {}))
      )
        throw new Error("Normal Passkey login did not yield usable credentials")
      return renewed
    }
    return {
      email,
      page,
      context,
      logout,
      credentials,
      login,
      virtualCredentials,
      /** Preflight before mutations; never replay a possibly completed mutation. */
      graphql: async (query: string, variables: Record<string, unknown> = {}) =>
        request(await credentials(), query, variables),
      dispose: async () => {
        try {
          // MCP may use the device again after setup. Save its final signature
          // counter before the next scenario borrows this named persona.
          if (options.saveCredentials) await retainDevice?.()
        } finally {
          if (options.page) {
            await cdp.send("WebAuthn.removeVirtualAuthenticator", {
              authenticatorId,
            })
            await cdp.detach()
          } else await context.close()
        }
      },
    }
  } catch (error) {
    try {
      await retainDevice?.()
    } finally {
      if (!options.page) await context.close().catch(() => undefined)
    }
    throw error
  }
}

export type PasskeyUser = Awaited<ReturnType<typeof createPasskeyUser>>
