/**
 * Use this provider to authenticate with Twitch.
 *
 * ```ts {5-8}
 * import { TwitchProvider } from "@openauthjs/openauth/provider/twitch"
 *
 * export default issuer({
 *   providers: {
 *     twitch: TwitchProvider({
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

export interface TwitchConfig extends Oauth2WrappedConfig {}

/**
 * Create a Twitch OAuth2 provider.
 *
 * @param config - The config for the provider.
 * @example
 * ```ts
 * TwitchProvider({
 *   clientID: "1234567890",
 *   clientSecret: "0987654321"
 * })
 * ```
 */
export function TwitchProvider(config: TwitchConfig) {
  return Oauth2Provider({
    type: "twitch",
    ...config,
    endpoint: {
      authorization: "https://id.twitch.tv/oauth2/authorize",
      token: "https://id.twitch.tv/oauth2/token",
    },
    resolveHumanIdentity: async (tokenset) => {
      const response = await fetchProviderJson(
        "https://api.twitch.tv/helix/users",
        tokenset,
        { "Client-Id": config.clientID },
      )
      const data = response["data"]
      const profile = Array.isArray(data) ? data[0] : undefined
      if (
        typeof profile !== "object" ||
        profile === null ||
        Array.isArray(profile)
      ) {
        throw new Error("Twitch identity response has no user")
      }
      return providerApiIdentity({
        provider: "twitch",
        subject: Reflect.get(profile, "id"),
        email: Reflect.get(profile, "email"),
        emailVerified: false,
        verificationClaim: "unsupported",
        name:
          Reflect.get(profile, "display_name") ?? Reflect.get(profile, "login"),
        picture: Reflect.get(profile, "profile_image_url"),
      })
    },
  })
}
