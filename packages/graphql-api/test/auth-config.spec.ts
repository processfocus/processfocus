import { Effect } from "effect"
import { readAuthConfigFromEnv } from "../src/lib/auth-config"
import { afterEach, describe, expect, it } from "bun:test"

const originalEnv = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnv }
})

const encodeBase64Url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url")

const makeJwt = (issuer: string): string =>
  [
    encodeBase64Url({ alg: "ES256", typ: "JWT" }),
    encodeBase64Url({
      iss: issuer,
      aud: "graphql-api",
      properties: { clientId: "frontend" },
    }),
    "signature",
  ].join(".")

describe("readAuthConfigFromEnv", () => {
  it("allows local frontend JWT issuer port drift", () => {
    process.env["NODE_ENV"] = "development"
    process.env["OAUTH_ISSUER_URL"] = "http://localhost:4021"
    process.env["FRONTEND_JWT_TOKEN"] = makeJwt("http://localhost:4020")

    const config = Effect.runSync(readAuthConfigFromEnv)

    expect(config.issuerUrl).toBe("http://localhost:4021")
    expect(config.issuerUrls).toEqual([
      "http://localhost:4021",
      "http://localhost:4020",
    ])
  })

  it("allows default local issuer drift without frontend JWT in GraphQL env", () => {
    process.env["NODE_ENV"] = "development"
    process.env["OAUTH_ISSUER_URL"] = "http://localhost:4021"
    delete process.env["FRONTEND_JWT_TOKEN"]

    const config = Effect.runSync(readAuthConfigFromEnv)

    expect(config.issuerUrls).toEqual([
      "http://localhost:4021",
      "http://localhost:4020",
    ])
  })

  it("does not duplicate the default local issuer", () => {
    process.env["NODE_ENV"] = "development"
    process.env["OAUTH_ISSUER_URL"] = "http://localhost:4020"
    process.env["FRONTEND_JWT_TOKEN"] = makeJwt("http://localhost:4020")

    const config = Effect.runSync(readAuthConfigFromEnv)

    expect(config.issuerUrls).toEqual(["http://localhost:4020"])
  })

  it("does not duplicate a matching non-default local issuer", () => {
    process.env["NODE_ENV"] = "development"
    process.env["OAUTH_ISSUER_URL"] = "http://localhost:4021"
    process.env["FRONTEND_JWT_TOKEN"] = makeJwt("http://localhost:4021")

    const config = Effect.runSync(readAuthConfigFromEnv)

    expect(config.issuerUrls).toEqual(["http://localhost:4021"])
  })

  it("allows IPv6 loopback frontend JWT issuer port drift", () => {
    process.env["NODE_ENV"] = "development"
    process.env["OAUTH_ISSUER_URL"] = "http://[::1]:4021"
    process.env["FRONTEND_JWT_TOKEN"] = makeJwt("http://[::1]:4020")

    const config = Effect.runSync(readAuthConfigFromEnv)

    expect(config.issuerUrls).toEqual([
      "http://[::1]:4021",
      "http://[::1]:4020",
    ])
  })

  it("does not allow loopback issuer drift across hostnames", () => {
    process.env["NODE_ENV"] = "development"
    process.env["OAUTH_ISSUER_URL"] = "http://127.0.0.1:4021"
    process.env["FRONTEND_JWT_TOKEN"] = makeJwt("http://localhost:4020")

    const config = Effect.runSync(readAuthConfigFromEnv)

    expect(config.issuerUrls).toEqual(["http://127.0.0.1:4021"])
  })

  it("does not fall back to default local issuer when JWT loopback host differs", () => {
    process.env["NODE_ENV"] = "development"
    process.env["OAUTH_ISSUER_URL"] = "http://localhost:4021"
    process.env["FRONTEND_JWT_TOKEN"] = makeJwt("http://127.0.0.1:4020")

    const config = Effect.runSync(readAuthConfigFromEnv)

    expect(config.issuerUrls).toEqual(["http://localhost:4021"])
  })

  it("keeps strict issuer checking for production", () => {
    process.env["NODE_ENV"] = "production"
    process.env["OAUTH_ISSUER_URL"] = "http://localhost:4021"
    process.env["FRONTEND_JWT_TOKEN"] = makeJwt("http://localhost:4020")

    const config = Effect.runSync(readAuthConfigFromEnv)

    expect(config.issuerUrls).toEqual(["http://localhost:4021"])
  })

  it("keeps strict issuer checking when NODE_ENV is unset", () => {
    delete process.env["NODE_ENV"]
    process.env["OAUTH_ISSUER_URL"] = "http://localhost:4021"
    process.env["FRONTEND_JWT_TOKEN"] = makeJwt("http://localhost:4020")

    const config = Effect.runSync(readAuthConfigFromEnv)

    expect(config.issuerUrls).toEqual(["http://localhost:4021"])
  })

  it("keeps strict issuer checking outside development", () => {
    process.env["NODE_ENV"] = "test"
    process.env["OAUTH_ISSUER_URL"] = "http://localhost:4021"
    process.env["FRONTEND_JWT_TOKEN"] = makeJwt("http://localhost:4020")

    const config = Effect.runSync(readAuthConfigFromEnv)

    expect(config.issuerUrls).toEqual(["http://localhost:4021"])
  })

  it("does not allow non-loopback issuer drift", () => {
    process.env["NODE_ENV"] = "development"
    process.env["OAUTH_ISSUER_URL"] = "https://auth.example.com"
    process.env["FRONTEND_JWT_TOKEN"] = makeJwt("http://localhost:4020")

    const config = Effect.runSync(readAuthConfigFromEnv)

    expect(config.issuerUrls).toEqual(["https://auth.example.com"])
  })
})
