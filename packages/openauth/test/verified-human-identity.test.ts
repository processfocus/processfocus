import { verifiedAppleIdentity } from "../src/provider/apple"
import { verifiedOidcIdentity } from "../src/provider/provider"
import {
  fetchProviderJson,
  providerApiIdentity,
} from "../src/provider/provider-api"
import { afterEach, describe, expect, it } from "bun:test"

describe("verified human identity adapters", () => {
  it("maps verified OIDC claims and normalizes email", () => {
    const identity = verifiedOidcIdentity("oidc", {
      sub: "subject",
      email: "  User@Example.COM ",
      email_verified: true,
      name: "Example User",
    })

    expect(String(identity?.email)).toBe("user@example.com")
    expect(identity?.emailVerification.method).toBe("oidc-claim")
  })

  it("accepts Apple's protocol-valid string verification claim", () => {
    expect(
      verifiedAppleIdentity({
        sub: "apple-subject",
        email: "user@example.com",
        email_verified: "true",
      })?.subject,
    ).toBe("apple-subject")
  })

  for (const claims of [
    { sub: "subject", email: "user@example.com", email_verified: false },
    { sub: "subject", email: "user@example.com" },
    { sub: "subject", email_verified: true },
  ]) {
    it(`rejects invalid OIDC claims ${JSON.stringify(claims)}`, () => {
      expect(verifiedOidcIdentity("oidc", claims)).toBeUndefined()
    })
  }

  it("maps an explicitly verified provider API email", () => {
    const result = providerApiIdentity({
      provider: "oauth",
      subject: 42,
      email: " Api.User@Example.COM ",
      emailVerified: true,
      verificationClaim: "emails[].verified",
      name: "API User",
    })

    expect(String(result.verifiedIdentity?.email)).toBe("api.user@example.com")
    expect(result.verifiedIdentity?.emailVerification.method).toBe(
      "provider-api",
    )
  })

  for (const input of [
    { email: "user@example.com", emailVerified: false },
    { email: "user@example.com", emailVerified: undefined },
    { email: undefined, emailVerified: true },
  ]) {
    it(`does not verify provider API input ${JSON.stringify(input)}`, () => {
      const result = providerApiIdentity({
        provider: "oauth",
        subject: "subject",
        verificationClaim: "verified",
        ...input,
      })
      expect(result.claims["sub"]).toBe("subject")
      expect(result.verifiedIdentity).toBeUndefined()
    })
  }
})

describe("provider API failures", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("rejects a provider failure", async () => {
    globalThis.fetch = Object.assign(
      () => Promise.resolve(Response.json({ error: "failed" }, { status: 503 })),
      { preconnect: originalFetch.preconnect },
    )

    await expect(
      fetchProviderJson("https://provider.example/user", {
        access: "token",
        refresh: "",
        expiry: 0,
        raw: {},
      }),
    ).rejects.toThrow("Invalid provider identity response")
  })

  it("rejects a malformed provider response", async () => {
    globalThis.fetch = Object.assign(
      () => Promise.resolve(Response.json(["not", "an", "object"])),
      { preconnect: originalFetch.preconnect },
    )

    await expect(
      fetchProviderJson("https://provider.example/user", {
        access: "token",
        refresh: "",
        expiry: 0,
        raw: {},
      }),
    ).rejects.toThrow("Invalid provider identity response")
  })
})
