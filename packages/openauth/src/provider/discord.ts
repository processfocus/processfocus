/**
 * Use this provider to authenticate with Discord.
 *
 * ```ts {5-8}
 * import { DiscordProvider } from "@openauthjs/openauth/provider/discord"
 *
 * export default issuer({
 *   providers: {
 *     discord: DiscordProvider({
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

export interface DiscordConfig extends Oauth2WrappedConfig {}

/**
 * Create a Discord OAuth2 provider.
 *
 * @param config - The config for the provider.
 * @example
 * ```ts
 * DiscordProvider({
 *   clientID: "1234567890",
 *   clientSecret: "0987654321"
 * })
 * ```
 */
export function DiscordProvider(config: DiscordConfig) {
  return Oauth2Provider({
    type: "discord",
    ...config,
    endpoint: {
      authorization: "https://discord.com/oauth2/authorize",
      token: "https://discord.com/api/oauth2/token",
    },
    resolveHumanIdentity: async (tokenset) => {
      const profile = await fetchProviderJson(
        "https://discord.com/api/users/@me",
        tokenset,
      )
      const id = profile["id"]
      const avatar = profile["avatar"]
      return providerApiIdentity({
        provider: "discord",
        subject: id,
        email: profile["email"],
        emailVerified: profile["verified"],
        verificationClaim: "verified",
        name: profile["global_name"] ?? profile["username"],
        picture:
          typeof id === "string" && typeof avatar === "string"
            ? `https://cdn.discordapp.com/avatars/${id}/${avatar}.png`
            : undefined,
      })
    },
  })
}
