/**
 * Use this provider to authenticate with X.com.
 *
 * ```ts {5-8}
 * import { XProvider } from "@openauthjs/openauth/provider/x"
 *
 * export default issuer({
 *   providers: {
 *     x: XProvider({
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
import { fetchProviderJson, providerApiIdentity } from "./provider-api.js"

export interface XProviderConfig extends Oauth2WrappedConfig {}

/**
 * Create a X.com OAuth2 provider.
 *
 * @param config - The config for the provider.
 * @example
 * ```ts
 * XProvider({
 *   clientID: "1234567890",
 *   clientSecret: "0987654321"
 * })
 * ```
 */
export function XProvider(config: XProviderConfig) {
  return Oauth2Provider({
    ...config,
    type: "x",
    endpoint: {
      authorization: "https://twitter.com/i/oauth2/authorize",
      token: "https://api.x.com/2/oauth2/token",
    },
    pkce: true,
    resolveHumanIdentity: async (tokenset) => {
      const response = await fetchProviderJson(
        "https://api.x.com/2/users/me?user.fields=profile_image_url",
        tokenset,
      )
      const profile = response["data"]
      if (
        typeof profile !== "object" ||
        profile === null ||
        Array.isArray(profile)
      ) {
        throw new Error("X identity response has no user")
      }
      return providerApiIdentity({
        provider: "x",
        subject: Reflect.get(profile, "id"),
        emailVerified: false,
        verificationClaim: "unsupported",
        name: Reflect.get(profile, "name") ?? Reflect.get(profile, "username"),
        picture: Reflect.get(profile, "profile_image_url"),
      })
    },
  })
}
