import { type Oauth2Config, Oauth2Provider } from "../src/provider/oauth2"
import { describe, expect, it } from "bun:test"

describe("Oauth2Provider", () => {
  it("rejects verified identity mapping without an OIDC issuer", () => {
    const config: Oauth2Config = {
      clientID: "client-id",
      clientSecret: "client-secret",
      endpoint: {
        authorization: "https://provider.example.com/authorize",
        token: "https://provider.example.com/token",
        jwks: "https://provider.example.com/jwks",
      },
      scopes: ["openid", "email"],
      mapVerifiedHumanIdentity: () => undefined,
    }

    expect(() => Reflect.apply(Oauth2Provider, undefined, [config])).toThrow(
      "Verified human identity mapping requires an OIDC issuer",
    )
  })

  it("keeps non-human oauth2 providers on the tokenset result type", () => {
    const provider = Oauth2Provider({
      clientID: "client-id",
      clientSecret: "client-secret",
      endpoint: {
        authorization: "https://provider.example.com/authorize",
        token: "https://provider.example.com/token",
      },
      scopes: ["api"],
    })
    expect(provider.type).toBe("oauth2")
  })
})
