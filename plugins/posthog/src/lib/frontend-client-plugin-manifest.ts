import { Config, ConfigProvider, Effect } from "effect"
import type { OrganisationFrontendPluginManifestClientPlugin } from "@pf/frontend-manifest"
import {
  POSTHOG_FRONTEND_CLIENT_PLUGIN_MODULE,
  POSTHOG_FRONTEND_CLIENT_PLUGIN_TYPE,
  parsePostHogFrontendClientPluginConfig,
} from "./frontend-client-plugin"

const resolveConfigString = (value: unknown, path: string): string => {
  if (!Config.isConfig(value)) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`${path} must be a non-empty string`)
    }

    return value.trim()
  }

  try {
    const resolved = Effect.runSync(
      Effect.withConfigProvider(value, ConfigProvider.fromEnv()),
    )

    if (typeof resolved !== "string" || resolved.trim().length === 0) {
      throw new Error(`${path} must be a non-empty string`)
    }

    return resolved.trim()
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === `${path} must be a non-empty string`
    ) {
      throw error
    }

    throw new Error(
      `${path} could not be resolved from environment config: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export const buildPostHogFrontendClientPluginManifest = (options: {
  readonly apiKey: string | Config.Config<string>
  readonly host: string
  readonly path: string
  readonly enabled?: boolean
}): OrganisationFrontendPluginManifestClientPlugin => {
  const config = parsePostHogFrontendClientPluginConfig(
    {
      apiKey: resolveConfigString(options.apiKey, `${options.path}.apiKey`),
      host: options.host,
      ...(options.enabled !== undefined ? { enabled: options.enabled } : {}),
    },
    `${options.path} frontend client plugin`,
  )

  return {
    module: POSTHOG_FRONTEND_CLIENT_PLUGIN_MODULE,
    type: POSTHOG_FRONTEND_CLIENT_PLUGIN_TYPE,
    config: {
      apiKey: config.apiKey,
      host: config.host,
      ...(config.enabled !== undefined ? { enabled: config.enabled } : {}),
    },
  }
}
