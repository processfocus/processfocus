import { Effect } from "effect"
import { getHost, getIssuerUrl, getProtocol } from "../src/request"
import { describe, expect, test } from "bun:test"

describe("getHost", () => {
  test("prefers x-forwarded-host over host", () => {
    const headers = {
      host: "localhost:4020",
      "x-forwarded-host": "example.cloudfront.net",
    }
    expect(getHost(headers)).toBe("example.cloudfront.net")
  })

  test("falls back to host when x-forwarded-host is not present", () => {
    const headers = {
      host: "localhost:4020",
    }
    expect(getHost(headers)).toBe("localhost:4020")
  })

  test("returns undefined when neither header is present", () => {
    const headers = {}
    expect(getHost(headers)).toBeUndefined()
  })

  test("returns x-forwarded-host even when host is undefined", () => {
    const headers = {
      host: undefined,
      "x-forwarded-host": "example.com",
    }
    expect(getHost(headers)).toBe("example.com")
  })
})

describe("getProtocol", () => {
  test("returns https when x-forwarded-proto is https", () => {
    const headers = { "x-forwarded-proto": "https" }
    expect(getProtocol(headers)).toBe("https")
  })

  test("returns http when x-forwarded-proto is http", () => {
    const headers = { "x-forwarded-proto": "http" }
    expect(getProtocol(headers)).toBe("http")
  })

  test("returns http when x-forwarded-proto is not present", () => {
    const headers = {}
    expect(getProtocol(headers)).toBe("http")
  })

  test("rejects values other than http or https", () => {
    const headers = { "x-forwarded-proto": "ftp" }
    expect(getProtocol(headers)).toBeUndefined()
  })

  test.each([
    [{ "cloudfront-forwarded-proto": "https" }, "https"],
    [{ "cloudfront-forwarded-proto": "https", "x-forwarded-proto": "http" }, "https"],
    [{ "cloudfront-forwarded-proto": "http", "x-forwarded-proto": "https" }, "http"],
    [{ "cloudfront-forwarded-proto": "https,http", "x-forwarded-proto": "https" }, undefined],
    [{ "cloudfront-forwarded-proto": "", "x-forwarded-proto": "https" }, undefined],
  ] as const)("uses authoritative CloudFront protocol: %j", (headers, expected) => {
    expect(getProtocol(headers)).toBe(expected)
  })
})

describe("getIssuerUrl", () => {
  test("rejects malformed protocol instead of minting a downgraded issuer", () => {
    const result = Effect.runSync(getIssuerUrl({ host: "auth.example.com", "cloudfront-forwarded-proto": "https,http", "x-forwarded-proto": "https" }).pipe(Effect.flip))
    expect(result._tag).toBe("@pf/openauth/OAuthEndpointError")
  })
  test("constructs URL from x-forwarded-host and x-forwarded-proto", () => {
    const headers = {
      host: "localhost:4020",
      "x-forwarded-host": "example.cloudfront.net",
      "x-forwarded-proto": "https",
    }
    const result = Effect.runSync(getIssuerUrl(headers))
    expect(result).toBe("https://example.cloudfront.net")
  })

  test("uses host when x-forwarded-host is not present", () => {
    const headers = {
      host: "localhost:4020",
      "x-forwarded-proto": "http",
    }
    const result = Effect.runSync(getIssuerUrl(headers))
    expect(result).toBe("http://localhost:4020")
  })

  test("defaults to http protocol when x-forwarded-proto is not present", () => {
    const headers = {
      host: "example.com",
    }
    const result = Effect.runSync(getIssuerUrl(headers))
    expect(result).toBe("http://example.com")
  })

  test("fails with MissingHostError when no host headers present", () => {
    const headers = {}
    const result = Effect.runSyncExit(getIssuerUrl(headers))
    expect(result._tag).toBe("Failure")
  })

  test("prefers x-forwarded-host in Lambda/CloudFront scenario", () => {
    // Simulates AWS Lambda behind CloudFront where:
    // - host is the internal Lambda address
    // - x-forwarded-host is the CloudFront domain
    const headers = {
      host: "127.0.0.1:4020",
      "x-forwarded-host": "d1234abcd.cloudfront.net",
      "x-forwarded-proto": "https",
    }
    const result = Effect.runSync(getIssuerUrl(headers))
    expect(result).toBe("https://d1234abcd.cloudfront.net")
  })
})
