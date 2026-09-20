import { instant } from "@next/playwright"
import type { BrowserContext, Page } from "@playwright/test"
import { test as base, createBdd } from "playwright-bdd"
import {
  getEffectiveAuthUrl,
  getEffectiveGraphqlEndpoint,
} from "@pf/frontend-endpoints/port-files"

// E2E OAuth client configuration
export const appDialog = (page: Page) =>
  page.locator('[role="dialog"]:not([data-nextjs-dialog])')

const E2E_CLIENT_ID = process.env["E2E_CLIENT_ID"] ?? "e2e-employee"
const E2E_CLIENT_SECRET = process.env["CI_PIPELINE_SECRET"] ?? ""
// Production probes run Next and the disposable backend on separate ports.
const AUTH_URL = process.env["OAUTH_ISSUER_URL"] ?? getEffectiveAuthUrl()

/**
 * Fixture for authenticating as a provider user via M2M client_credentials grant.
 * Injects access_token and, when present, refresh_token cookies into the browser context.
 */
type AuthenticateAsProviderUser = (
  email: string,
  roles?: string[],
  clientId?: string,
) => Promise<void>

interface TestFixtures {
  instantUI: (assertUI: () => Promise<void>) => Promise<void>
  authenticateAsProviderUser: AuthenticateAsProviderUser
  scenarioState: Map<string, unknown>
}

/**
 * Build OAuth2 scope string for provider user authentication.
 * Format: "email:user@example.com role:/Manager"
 */
const buildScope = (email: string, roles?: string[]): string => {
  const parts: string[] = [`email:${encodeURIComponent(email)}`]

  if (roles && roles.length > 0) {
    for (const role of roles) {
      parts.push(`role:${encodeURIComponent(role)}`)
    }
  }

  return parts.join(" ")
}

/**
 * Check if we're testing against AWS with AppSync Events.
 * AppSync requires access_token to be readable by JavaScript for WebSocket auth.
 */
const isAppSyncDeployment = (): boolean =>
  !!process.env["APPSYNC_EVENTS_HTTP_HOST"] || !!process.env["BASE_URL"]

/**
 * Compute cookie names matching the frontend's getCookieNamesFromHost().
 * On localhost, cookies are port-suffixed to avoid collisions between instances.
 */
const getCookieNames = (baseUrl: URL) => {
  const isLocalhost =
    baseUrl.hostname === "localhost" || baseUrl.hostname === "127.0.0.1"
  const suffix = isLocalhost && baseUrl.port ? `_${baseUrl.port}` : ""
  return {
    accessToken: `access_token${suffix}`,
    refreshToken: `refresh_token${suffix}`,
  }
}

/**
 * Inject authentication cookies into browser context.
 */
const injectCookies = async (
  context: BrowserContext,
  accessToken: string,
  refreshToken?: string,
): Promise<void> => {
  const baseUrl = new URL(process.env["BASE_URL"] ?? "http://localhost:3000")
  const cookieNames = getCookieNames(baseUrl)
  // For AppSync deployments, access_token must be readable by JavaScript
  // for WebSocket authentication
  const accessTokenHttpOnly = !isAppSyncDeployment()

  await context.addCookies([
    {
      name: cookieNames.accessToken,
      value: accessToken,
      domain: baseUrl.hostname,
      path: "/",
      httpOnly: accessTokenHttpOnly,
      secure: baseUrl.protocol === "https:",
      sameSite: "Lax",
    },
    ...(refreshToken
      ? [
          {
            name: cookieNames.refreshToken,
            value: refreshToken,
            domain: baseUrl.hostname,
            path: "/",
            httpOnly: true,
            secure: baseUrl.protocol === "https:",
            sameSite: "Lax" as const,
          },
        ]
      : []),
  ])
}

const requestProviderUserPermissions = async (
  accessToken: string,
  email: string,
): Promise<{ success: boolean; error?: string }> => {
  const response = await fetch(
    process.env["GRAPHQL_ENDPOINT"] ?? getEffectiveGraphqlEndpoint(),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        query: `
        mutation RequestProviderUserPermissions($email: String!) {
          requestProviderUserPermissions(email: $email) {
            success
            error
          }
        }
      `,
        variables: { email },
      }),
    },
  )
  const result = (await response.json()) as {
    data?: {
      requestProviderUserPermissions: {
        success: boolean
        error?: string
      }
    }
    errors?: Array<{ message: string }>
  }
  if (result.errors?.length) {
    return {
      success: false,
      error: result.errors[0]?.message ?? "Unknown error",
    }
  }
  return (
    result.data?.requestProviderUserPermissions ?? {
      success: false,
      error: "Request failed",
    }
  )
}

export const test = base.extend<TestFixtures>({
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
    // Fresh Map for each scenario - test-scoped state storage
    await use(new Map())
  },

  authenticateAsProviderUser: async ({ context }, use) => {
    const authenticate: AuthenticateAsProviderUser = async (
      email,
      roles,
      clientId,
    ) => {
      const effectiveClientId = clientId ?? E2E_CLIENT_ID
      const basic = Buffer.from(
        `${effectiveClientId}:${E2E_CLIENT_SECRET}`,
      ).toString("base64")

      const authenticateWithScope = async (scope: string) => {
        const response = await fetch(`${AUTH_URL}/oauth/token`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${basic}`,
          },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            scope,
          }).toString(),
        })

        if (!response.ok) {
          const error = await response.text()
          throw new Error(`Failed to authenticate as ${email}: ${error}`)
        }

        const tokens = (await response.json()) as {
          access_token: string
          refresh_token?: string
        }

        return tokens
      }

      let tokens: { access_token: string; refresh_token?: string }

      if (email) {
        const baseAuth = await authenticateWithScope("")
        const permResult = await requestProviderUserPermissions(
          baseAuth.access_token,
          email,
        )
        if (!permResult.success) {
          throw new Error(
            `Failed to request provider user permissions for ${email}: ${permResult.error}`,
          )
        }
        const scope = buildScope(email, roles)
        tokens = await authenticateWithScope(scope)
        // Ignore roles for now, if we have a step that requires the provider user to
        // switch to particular role, better to indicate that with an extra
        // step instead of trying to combine that. You want to know the provider user
        // switches to non-default roles.
      } else {
        const scope = buildScope(email, roles)
        tokens = await authenticateWithScope(scope)
      }

      await injectCookies(context, tokens.access_token, tokens.refresh_token)
    }

    await use(authenticate)
  },
})

export const { Given, When, Then } = createBdd(test)
