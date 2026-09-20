/**
 * A dummy provider for testing and development purposes.
 *
 * This provider auto-completes the OAuth flow without requiring any external service.
 * It should only be enabled in non-production environments.
 *
 * @example
 * ```ts
 * import { DummyProvider } from "@pf/openauth/provider/dummy"
 *
 * export default issuer({
 *   providers: {
 *     dummy: DummyProvider({
 *       email: "test@example.com",
 *       sub: "test-user-123"
 *     })
 *   }
 * })
 * ```
 *
 * @packageDocumentation
 */

import { HttpRouter } from "@effect/platform"
import type { Oauth2Token } from "./oauth2.js"
import type { Provider, ProviderOptions } from "./provider.js"

/**
 * Configuration for the dummy provider.
 */
export interface DummyConfig {
  /**
   * The email address to return for the authenticated user.
   * @default "test@example.com"
   */
  email?: string
  /**
   * The subject identifier to return for the authenticated user.
   * @default "dummy-user-id"
   */
  sub?: string
  /**
   * The name to return for the authenticated user.
   * @default "Test User"
   */
  name?: string
}

/**
 * Properties returned by the dummy provider after successful authentication.
 * Uses the same structure as OAuth2 providers: { tokenset, clientID }
 */
export type DummyProperties = { tokenset: Oauth2Token; clientID: string }

/**
 * Create a dummy provider for testing.
 *
 * This provider immediately completes authentication without any user interaction.
 * It returns a mock ID token payload with configurable claims.
 *
 * **WARNING**: Only use this provider in non-production environments.
 *
 * @param config - Optional configuration for the mock user.
 */
export function DummyProvider(
  config: DummyConfig = {},
): Provider<DummyProperties> {
  const email = config.email ?? "test@example.com"
  const sub = config.sub ?? "dummy-user-id"
  const name = config.name ?? "Test User"

  /**
   * Create ID token payload with fresh timestamps.
   * Called per-request to ensure tokens don't appear expired in long-running processes.
   */
  const createIdTokenPayload = () => {
    const now = Math.floor(Date.now() / 1000)
    return {
      iss: "dummy-issuer",
      aud: "dummy-client",
      exp: now + 3600,
      iat: now,
      email,
      sub,
      name,
    }
  }

  /**
   * Create the full properties object with fresh timestamps.
   */
  const createProperties = (): DummyProperties => ({
    clientID: "dummy-client",
    tokenset: {
      access: "dummy-access-token",
      refresh: "dummy-refresh-token",
      expiry: 3600,
      id: createIdTokenPayload(),
      raw: {
        access_token: "dummy-access-token",
        refresh_token: "dummy-refresh-token",
        expires_in: 3600,
        token_type: "Bearer",
      },
    },
  })

  return {
    type: "dummy",
    init(options: ProviderOptions<DummyProperties>) {
      // Build an HttpRouter with a single GET /authorize route
      // that immediately completes authentication
      return HttpRouter.empty.pipe(
        HttpRouter.get("/authorize", options.success(createProperties())),
      )
    },
    // Support client credentials flow for programmatic testing
    client: async () => createProperties(),
  }
}
