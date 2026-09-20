/**
 * Use this provider to authenticate with a Cognito OAuth endpoint.
 *
 * ```ts {5-10}
 * import { CognitoProvider } from "@openauthjs/openauth/provider/cognito"
 *
 * export default issuer({
 *   providers: {
 *     cognito: CognitoProvider({
 *       domain: "your-domain.auth.us-east-1.amazoncognito.com",
 *       region: "us-east-1",
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
import { fetchProviderJson, providerApiIdentity } from "./provider-api.js"

export interface CognitoConfig extends Oauth2WrappedConfig {
  /**
   * The domain of the Cognito User Pool.
   *
   * @example
   * ```ts
   * {
   *   domain: "your-domain.auth.us-east-1.amazoncognito.com"
   * }
   * ```
   *
   * Just provide "your-domain" for `domain`.
   */
  domain: string
  /**
   * The region the Cognito User Pool is in.
   *
   * @example
   * ```ts
   * {
   *   region: "us-east-1"
   * }
   * ```
   */
  region: string
  /** User pool ID required to verify OIDC ID tokens before user creation. */
  userPoolId?: string
}

/**
 * Create a Cognito OAuth2 provider.
 *
 * @param config - The config for the provider.
 * @example
 * ```ts
 * CognitoProvider({
 *   domain: "your-domain", // from "your-domain.auth.us-east-1.amazoncognito.com"
 *   region: "us-east-1",
 *   clientID: "1234567890",
 *   clientSecret: "0987654321"
 * })
 * ```
 */
export function CognitoProvider(config: CognitoConfig) {
  const domain = `${config.domain}.auth.${config.region}.amazoncognito.com`
  const issuer = config.userPoolId
    ? `https://cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`
    : undefined

  return Oauth2Provider({
    type: "cognito",
    ...config,
    endpoint: {
      authorization: `https://${domain}/oauth2/authorize`,
      token: `https://${domain}/oauth2/token`,
      ...(issuer ? { jwks: `${issuer}/.well-known/jwks.json` } : {}),
    },
    ...(issuer
      ? {
          issuer,
          mapVerifiedHumanIdentity: (payload: Record<string, unknown>) =>
            verifiedOidcIdentity("cognito", payload),
        }
      : {}),
    resolveHumanIdentity: async (tokenset) => {
      const profile = await fetchProviderJson(
        `https://${domain}/oauth2/userInfo`,
        tokenset,
      )
      const resolution = providerApiIdentity({
        provider: "cognito",
        subject: profile["sub"],
        email: profile["email"],
        emailVerified: profile["email_verified"],
        verificationClaim: "email_verified",
        name: profile["name"],
        givenName: profile["given_name"],
        familyName: profile["family_name"],
        picture: profile["picture"],
        locale: profile["locale"],
      })
      const idTokenSubject = tokenset.id?.["sub"]
      const verifiedIdentity =
        typeof idTokenSubject === "string" && profile["sub"] === idTokenSubject
          ? verifiedOidcIdentity("cognito", profile)
          : undefined
      return {
        claims: resolution.claims,
        ...(verifiedIdentity ? { verifiedIdentity } : {}),
      }
    },
  })
}
