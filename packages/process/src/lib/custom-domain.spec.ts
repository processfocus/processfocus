import { CustomDomain } from "./custom-domain"
import { Organisation } from "./organisation"
import { describe, expect, it } from "bun:test"

describe("CustomDomain", () => {
  it("normalizes configured domains", () => {
    const org = new Organisation({ name: "Test Org" })
    const customDomain = new CustomDomain(org, "custom-domain", {
      domains: {
        dev: "  Console.ProcessFocus.Com  ",
      },
    })

    expect(customDomain.domainForEnvironment("dev")).toBe(
      "console.processfocus.com",
    )
  })

  it("rejects domains under app.processfocus.com", () => {
    const org = new Organisation({ name: "Test Org" })

    expect(
      () =>
        new CustomDomain(org, "custom-domain", {
          domains: {
            dev: "foo.app.processfocus.com",
          },
        }),
    ).toThrow(
      'Custom domain for env "dev" cannot be under app.processfocus.com',
    )
  })

  it("rejects malformed domain names", () => {
    const org = new Organisation({ name: "Test Org" })

    expect(
      () =>
        new CustomDomain(org, "custom-domain", {
          domains: {
            dev: "https://example.com/path",
          },
        }),
    ).toThrow(
      'Custom domain for env "dev" must be a valid domain name, got: https://example.com/path',
    )
  })
})
