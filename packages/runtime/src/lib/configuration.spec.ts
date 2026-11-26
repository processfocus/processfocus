import {
  Config,
  ConfigProvider,
  Effect,
  Option,
  Redacted,
  Result,
} from "effect"
import { describe, expect, it } from "vitest"
import {
  configurationField,
  configurationSecret,
  configurationString,
  readConfiguration,
  validateConfiguration,
} from "./configuration.js"

const group = {
  owner: "example",
  target: "worker",
  fields: {
    secret: configurationField(
      "CUSTOM_SECRET",
      configurationSecret("CUSTOM_SECRET"),
      { secret: true },
    ),
    optional: configurationField(
      "OPTIONAL",
      Config.option(Config.Int("OPTIONAL")),
    ),
    enabled: configurationField(
      "ENABLED",
      Config.Boolean("ENABLED").pipe(Config.withDefault(false)),
    ),
    recipient: configurationField(
      "RECIPIENT",
      Config.option(configurationString("RECIPIENT")),
    ),
  },
  rules: [{ when: "enabled", equals: false, required: "recipient" }],
}

// Protect the public runtime/preflight semantics; deployment tests own transport
// and rejection before infrastructure work.
describe("shared configuration", () => {
  it.each([
    [{ CUSTOM_SECRET: "hidden", ENABLED: "true" }, []],
    [{ CUSTOM_SECRET: "hidden", ENABLED: "true", OPTIONAL: "" }, []],
    [{ CUSTOM_SECRET: "", ENABLED: "true" }, ["CUSTOM_SECRET"]],
    [
      { CUSTOM_SECRET: "hidden", OPTIONAL: "bad", ENABLED: "true" },
      ["OPTIONAL"],
    ],
    [{ CUSTOM_SECRET: "hidden" }, ["RECIPIENT"]],
    [{ CUSTOM_SECRET: "hidden", ENABLED: "invalid" }, ["ENABLED"]],
    [{ CUSTOM_SECRET: "hidden", RECIPIENT: "recipient@example.com" }, []],
  ])("runtime and preflight agree for %j", async (values, keys) => {
    const provider = ConfigProvider.fromEnvRecord(values)
    const runtime = await Effect.runPromise(
      Effect.result(readConfiguration(group)).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, provider),
      ),
    )
    const diagnostics = await Effect.runPromise(
      validateConfiguration({ version: 1, groups: [group] }).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, provider),
      ),
    )
    expect(diagnostics.map((item) => item.key)).toEqual(keys)
    expect(Result.isSuccess(runtime)).toBe(keys.length === 0)
    expect(JSON.stringify(diagnostics)).not.toContain("hidden")
    if (Result.isSuccess(runtime)) {
      expect(Redacted.value(runtime.success.secret)).toBe("hidden")
      expect(Option.isNone(runtime.success.optional)).toBe(true)
    }
  })

  it("checks every consumer of a shared key", async () => {
    const other = {
      owner: "other",
      target: "worker",
      fields: {
        count: configurationField("CUSTOM_SECRET", Config.Int("CUSTOM_SECRET")),
      },
      rules: [],
    }
    const diagnostics = await Effect.runPromise(
      validateConfiguration({ version: 1, groups: [group, other] }).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord({
            CUSTOM_SECRET: "hidden",
            ENABLED: "true",
          }),
        ),
      ),
    )
    expect(diagnostics.map(({ owner, key }) => ({ owner, key }))).toEqual([
      { owner: "other", key: "CUSTOM_SECRET" },
    ])
  })
})
