import { ConfigProvider, Effect } from "effect"
import { resolveIssuerClients } from "../src/issuer.js"
import { describe, expect, test } from "bun:test"

describe("issuer ConfigProvider", () => {
  test("merges configured clients while preserving static precedence", async () => {
    const clients = await Effect.runPromise(resolveIssuerClients([
      { id: "static", redirectUris: ["https://static.example/callback"] },
    ]).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({
      OPENAUTH_CLIENTS: JSON.stringify([
        { id: "static", redirectUris: ["https://ignored.example/callback"] },
        { id: "configured", redirectUris: ["https://configured.example/callback"] },
      ]),
    })))))
    expect(clients).toEqual([
      { id: "static", redirectUris: ["https://static.example/callback"] },
      { id: "configured", redirectUris: ["https://configured.example/callback"] },
    ])
  })

  test.each([undefined, ""])("missing/empty clients preserve static clients (%s)", async (raw) => {
    const clients = await Effect.runPromise(resolveIssuerClients([
      { id: "static", redirectUris: [] },
    ]).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ OPENAUTH_CLIENTS: raw })))))
    expect(clients).toEqual([{ id: "static", redirectUris: [] }])
  })

  test.each([
    ["{", "OPENAUTH_CLIENTS contains invalid JSON"],
    ["{}", "OPENAUTH_CLIENTS must be a JSON array"],
  ])("maps invalid config to the issuer error (%s)", async (raw, message) => {
    const error = await Effect.runPromise(resolveIssuerClients().pipe(
      Effect.flip,
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ OPENAUTH_CLIENTS: raw }))),
    ))
    expect(error._tag).toBe("@pf/openauth/ResolveIssuerClientsError")
    expect(error.message).toContain(message)
  })
  test("maps provider failures to the issuer error", async () => {
    const provider = ConfigProvider.make(() => Effect.fail(new ConfigProvider.SourceError({ message: "unavailable" })))
    const error = await Effect.runPromise(resolveIssuerClients().pipe(
      Effect.flip,
      Effect.provide(ConfigProvider.layer(provider)),
    ))
    expect(error._tag).toBe("@pf/openauth/ResolveIssuerClientsError")
    expect(error.message).toBe("Failed to load OPENAUTH_CLIENTS configuration")
  })

})
