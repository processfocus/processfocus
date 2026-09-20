/**
 * Use this provider to authenticate with Github.
 *
 * ```ts {5-8}
 * import { GithubProvider } from "@openauthjs/openauth/provider/github"
 *
 * export default issuer({
 *   providers: {
 *     github: GithubProvider({
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
import {
  fetchProviderArray,
  fetchProviderJson,
  providerApiIdentity,
} from "./provider-api.js"

export interface GithubConfig extends Oauth2WrappedConfig {}

/**
 * Create a Github OAuth2 provider.
 *
 * @param config - The config for the provider.
 * @example
 * ```ts
 * GithubProvider({
 *   clientID: "1234567890",
 *   clientSecret: "0987654321"
 * })
 * ```
 */
export function GithubProvider(config: GithubConfig) {
  return Oauth2Provider({
    ...config,
    type: "github",
    endpoint: {
      authorization: "https://github.com/login/oauth/authorize",
      token: "https://github.com/login/oauth/access_token",
    },
    resolveHumanIdentity: async (tokenset) => {
      const profile = await fetchProviderJson(
        "https://api.github.com/user",
        tokenset,
        { "X-GitHub-Api-Version": "2022-11-28" },
      )
      // Email lookup failure must not hide a stable subject from an existing user.
      const emails: readonly unknown[] = await fetchProviderArray(
        "https://api.github.com/user/emails",
        tokenset,
      ).catch((): readonly unknown[] => [])
      const verifiedEmail = emails.find(
        (value): value is Record<string, unknown> =>
          typeof value === "object" &&
          value !== null &&
          !Array.isArray(value) &&
          Reflect.get(value, "verified") === true &&
          Reflect.get(value, "primary") === true,
      )
      return providerApiIdentity({
        provider: "github",
        subject: profile["id"],
        email: verifiedEmail?.["email"],
        emailVerified: verifiedEmail?.["verified"],
        verificationClaim: "/user/emails[].verified",
        name: profile["name"] ?? profile["login"],
        picture: profile["avatar_url"],
      })
    },
  })
}
