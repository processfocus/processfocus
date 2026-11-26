import {
  type ConfigurationGroup,
  configurationField,
  configurationString,
} from "@processfocus/runtime"
import { Config, Schema } from "effect"

/** An absent project token disables analytics; a supplied token requires a host. */
export const makePostHogConfiguration = (
  bindings: { readonly apiKey?: string; readonly host?: string } = {},
  overrides: { readonly host?: string; readonly enabled?: boolean } = {},
) => {
  const apiKey = bindings.apiKey ?? "POSTHOG_PROJECT_API_KEY"
  const host = bindings.host ?? "POSTHOG_HOST"
  const enabled =
    overrides.enabled === undefined
      ? Config.String("NODE_ENV").pipe(
          Config.withDefault("production"),
          Config.map((value) => value !== "development"),
        )
      : Config.succeed(overrides.enabled)
  const token = enabled.pipe(
    Config.flatMap((active) =>
      active
        ? configurationString(apiKey).pipe(Config.withDefault(""))
        : Config.succeed(""),
    ),
  )
  const hostSchema = Schema.String.pipe(
    Schema.check(
      Schema.makeFilter((value) => {
        try {
          const url = new URL(value.trim())
          return url.protocol === "http:" || url.protocol === "https:"
        } catch {
          return false
        }
      }),
    ),
  )
  const authoredHost =
    overrides.host === undefined
      ? undefined
      : Schema.decodeUnknownSync(hostSchema)(overrides.host)
  const hostConfig = Config.schema(hostSchema, host).pipe(
    Config.map((value) => value.trim().replace(/\/+$/, "")),
  )
  return {
    owner: "analytics.posthog",
    target: "frontend",
    fields: {
      enabled: configurationField("NODE_ENV", enabled, { source: "platform" }),
      apiKey: configurationField(apiKey, token),
      host: configurationField(
        host,
        token.pipe(
          Config.flatMap((value) =>
            value === ""
              ? Config.succeed("")
              : authoredHost === undefined
                ? hostConfig
                : Config.succeed(authoredHost.trim().replace(/\/+$/, "")),
          ),
        ),
      ),
    },
    rules: [],
  } satisfies ConfigurationGroup
}

export const PostHogConfiguration = makePostHogConfiguration()
