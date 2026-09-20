/**
 * Use this provider to authenticate with a Keycloak server.
 *
 * ```ts {5-10}
 * import { KeycloakProvider } from "@openauthjs/openauth/provider/keycloak"
 *
 * export default issuer({
 *   providers: {
 *     keycloak: KeycloakProvider({
 *       baseUrl: "https://your-keycloak-domain",
 *       realm: "your-realm",
 *       clientID: "1234567890",
 *       clientSecret: "0987654321"
 *     })
 *   }
 * })
 * ```
 *
 * @packageDocumentation
 */

import type { Oauth2WrappedConfig } from "./oauth2.js"
import { Oauth2Provider } from "./oauth2.js"
import { verifiedOidcIdentity } from "./provider.js"

export interface KeycloakConfig extends Oauth2WrappedConfig {
  /**
   * The base URL of the Keycloak server.
   *
   * @example
   * ```ts
   * {
   *   baseUrl: "https://your-keycloak-domain"
   * }
   * ```
   */
  baseUrl: string
  /**
   * The realm in the Keycloak server to authenticate against.
   *
   * A realm in Keycloak is like a tenant or namespace that manages a set of
   * users, credentials, roles, and groups.
   *
   * @example
   * ```ts
   * {
   *   realm: "your-realm"
   * }
   * ```
   */
  realm: string
}

/**
 * Create a Keycloak OAuth2 provider.
 *
 * @param config - The config for the provider.
 * @example
 * ```ts
 * KeycloakProvider({
 *   baseUrl: "https://your-keycloak-domain",
 *   realm: "your-realm",
 *   clientID: "1234567890",
 *   clientSecret: "0987654321"
 * })
 * ```
 */
export function KeycloakProvider(config: KeycloakConfig) {
  const issuer = `${config.baseUrl}/realms/${config.realm}`
  const baseConfig = {
    ...config,
    type: "keycloak",
    endpoint: {
      authorization: `${issuer}/protocol/openid-connect/auth`,
      token: `${issuer}/protocol/openid-connect/token`,
      jwks: `${issuer}/protocol/openid-connect/certs`,
    },
    issuer,
    mapVerifiedHumanIdentity: (payload: Record<string, unknown>) =>
      verifiedOidcIdentity("keycloak", payload),
  }
  return Oauth2Provider(baseConfig)
}
