import { Config, Effect, Option } from "effect"
import type { SecretClientsConfig } from "./authentication-config"

/** Legacy CI clients are local fixtures, never deployed authentication methods. */
export const localFixtureSecretClients = (
  clients: SecretClientsConfig,
): Effect.Effect<SecretClientsConfig, Config.ConfigError> =>
  Effect.gen(function* () {
    const issuer = yield* Config.option(Config.String("OAUTH_ISSUER_URL"))
    const mode = yield* Config.String("NODE_ENV").pipe(Config.withDefault(""))
    // Match local development's default issuer; production needs an explicit one.
    const value = Option.getOrElse(issuer, () =>
      mode === "production" ? "" : "http://localhost:4020",
    )
    try {
      const url = new URL(value)
      return ["http:", "https:"].includes(url.protocol) &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        ? clients
        : {}
    } catch {
      return {}
    }
  })
