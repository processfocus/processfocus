/**
 * Use this provider to authenticate with Facebook. Supports both OAuth2 and OIDC.
 *
 * #### Using OAuth
 *
 * ```ts {5-8}
 * import { FacebookProvider } from "@openauthjs/openauth/provider/facebook"
 *
 * export default issuer({
 *   providers: {
 *     facebook: FacebookProvider({
 *       clientID: "1234567890",
 *       clientSecret: "0987654321"
 *     })
 *   }
 * })
 * ```
 *
 * #### Using OIDC
 *
 * ```ts {5-7}
 * import { FacebookOidcProvider } from "@openauthjs/openauth/provider/facebook"
 *
 * export default issuer({
 *   providers: {
 *     facebook: FacebookOidcProvider({
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
import { fetchProviderJson, providerApiIdentity } from "./provider-api.js"

export interface FacebookConfig extends Oauth2WrappedConfig {}
export interface FacebookOidcConfig extends OidcWrappedConfig {}

/**
 * Create a Facebook OAuth2 provider.
 *
 * @param config - The config for the provider.
 * @example
 * ```ts
 * FacebookProvider({
 *   clientID: "1234567890",
 *   clientSecret: "0987654321"
 * })
 * ```
 */
export function FacebookProvider(config: FacebookConfig) {
  return Oauth2Provider({
    ...config,
    type: "facebook",
    endpoint: {
      authorization: "https://www.facebook.com/v12.0/dialog/oauth",
      token: "https://graph.facebook.com/v12.0/oauth/access_token",
    },
    resolveHumanIdentity: async (tokenset) => {
      const profile = await fetchProviderJson(
        "https://graph.facebook.com/v12.0/me?fields=id,name,first_name,last_name,picture,email",
        tokenset,
      )
      const picture = profile["picture"]
      const pictureData =
        typeof picture === "object" && picture !== null && !Array.isArray(picture)
          ? Reflect.get(picture, "data")
          : undefined
      return providerApiIdentity({
        provider: "facebook",
        subject: profile["id"],
        email: profile["email"],
        emailVerified: false,
        verificationClaim: "unsupported",
        name: profile["name"],
        givenName: profile["first_name"],
        familyName: profile["last_name"],
        picture:
          typeof pictureData === "object" &&
          pictureData !== null &&
          !Array.isArray(pictureData)
            ? Reflect.get(pictureData, "url")
            : undefined,
      })
    },
  })
}

/**
 * Create a Facebook OIDC provider.
 *
 * This is useful if you just want to verify the user's email address.
 *
 * @param config - The config for the provider.
 * @example
 * ```ts
 * FacebookOidcProvider({
 *   clientID: "1234567890"
 * })
 * ```
 */
export function FacebookOidcProvider(config: FacebookOidcConfig) {
  return OidcProvider({
    ...config,
    type: "facebook",
    issuer: "https://graph.facebook.com",
  })
}
