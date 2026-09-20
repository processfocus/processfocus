import { Schema } from "effect"
import { PasskeyProviderConfigSchema } from "../src"
import { describe, expect, it } from "bun:test"

describe("PasskeyProviderConfigSchema", () => {
  it("does not expose a configurable user verification policy", () => {
    const config = Schema.decodeUnknownSync(PasskeyProviderConfigSchema)({
      rpName: "Process Focus",
      rpID: "example.com",
      origin: "https://example.com",
      userVerification: "discouraged",
    })

    expect(config).toEqual({
      rpName: "Process Focus",
      rpID: "example.com",
      origin: "https://example.com",
    })
  })
})
