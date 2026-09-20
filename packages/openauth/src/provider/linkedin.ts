import { Oauth2Provider, type Oauth2WrappedConfig } from "./oauth2.js"
import { verifiedOidcIdentity } from "./provider.js"

export function LinkedInAdapter(config: Oauth2WrappedConfig) {
  return Oauth2Provider({
    ...config,
    type: "linkedin",
    endpoint: {
      authorization: "https://www.linkedin.com/oauth/v2/authorization",
      token: "https://www.linkedin.com/oauth/v2/accessToken",
      jwks: "https://www.linkedin.com/oauth/openid/jwks",
    },
    issuer: "https://www.linkedin.com/oauth",
    mapVerifiedHumanIdentity: (payload) =>
      verifiedOidcIdentity("linkedin", payload),
  })
}
