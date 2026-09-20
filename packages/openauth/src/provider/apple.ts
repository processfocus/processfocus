/**
 * Use this provider to authenticate with Apple. Supports both OAuth2 and OIDC.
 *
 * #### Using OAuth
 *
 * ```ts {5-8}
 * import { AppleProvider } from "@openauthjs/openauth/provider/apple"
 *
 * export default issuer({
 *   providers: {
 *     apple: AppleProvider({
 *       clientID: "1234567890",
 *       clientSecret: "0987654321"
 *     })
 *   }
 * })
 * ```
 *
 * #### Using OAuth with form_post response mode
 *
 * When requesting name or email scopes from Apple, you must use form_post response mode:
 *
 * ```ts {5-9}
 * import { AppleProvider } from "@openauthjs/openauth/provider/apple"
 *
 * export default issuer({
 *   providers: {
 *     apple: AppleProvider({
 *       clientID: "1234567890",
 *       clientSecret: "0987654321",
 *       responseMode: "form_post"
 *     })
 *   }
 * })
 * ```
 *
 * #### Using OIDC
 *
 * ```ts {5-7}
 * import { AppleOidcProvider } from "@openauthjs/openauth/provider/apple"
 *
 * export default issuer({
 *   providers: {
 *     apple: AppleOidcProvider({
 *       clientID: "1234567890"
 *     })
 *   }
 * })
 * ```
 *
 * @packageDocumentation
 */

import type { Oauth2WrappedConfig } from "./oauth2.js"
import { Oauth2Provider } from "./oauth2.js"
import type { OidcWrappedConfig } from "./oidc.js"
import { OidcProvider } from "./oidc.js"
import { verifiedOidcIdentity } from "./provider.js"

export interface AppleConfig extends Oauth2WrappedConfig {
  /**
   * The response mode to use for the authorization request.
   * Apple requires 'form_post' response mode when requesting name or email scopes.
   * @default "query"
   */
  responseMode?: "query" | "form_post"
}
export interface AppleOidcConfig extends OidcWrappedConfig {}

export const verifiedAppleIdentity = (payload: Record<string, unknown>) =>
  verifiedOidcIdentity("apple", {
    ...payload,
    email_verified:
      payload["email_verified"] === "true"
        ? true
        : payload["email_verified"],
  })

/**
 * Create an Apple OAuth2 provider.
 *
 * @param config - The config for the provider.
 * @example
 * ```ts
 * // Using default query response mode (GET callback)
 * AppleProvider({
 *   clientID: "1234567890",
 *   clientSecret: "0987654321"
 * })
 *
 * // Using form_post response mode (POST callback)
 * // Required when requesting name or email scope
 * AppleProvider({
 *   clientID: "1234567890",
 *   clientSecret: "0987654321",
 *   responseMode: "form_post",
 *   scopes: ["name", "email"]
 * })
 * ```
 */
export function AppleProvider(config: AppleConfig) {
  const { responseMode, ...restConfig } = config
  const additionalQuery =
    responseMode === "form_post"
      ? { response_mode: "form_post", ...config.query }
      : config.query || {}

  return Oauth2Provider({
    ...restConfig,
    type: "apple" as const,
    endpoint: {
      authorization: "https://appleid.apple.com/auth/authorize",
      token: "https://appleid.apple.com/auth/token",
      jwks: "https://appleid.apple.com/auth/keys",
    },
    issuer: "https://appleid.apple.com",
    mapVerifiedHumanIdentity: verifiedAppleIdentity,
    query: additionalQuery,
  })
}

/**
 * Create an Apple OIDC provider.
 *
 * This is useful if you just want to verify the user's email address.
 *
 * @param config - The config for the provider.
 * @example
 * ```ts
 * AppleOidcProvider({
 *   clientID: "1234567890"
 * })
 * ```
 */
export function AppleOidcProvider(config: AppleOidcConfig) {
  return OidcProvider({
    ...config,
    type: "apple" as const,
    issuer: "https://appleid.apple.com",
  })
}
