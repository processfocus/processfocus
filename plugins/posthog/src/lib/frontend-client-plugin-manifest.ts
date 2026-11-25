import type { OrganisationFrontendPluginManifestClientPlugin } from "@pf/frontend-manifest"
import {
  POSTHOG_FRONTEND_CLIENT_PLUGIN_MODULE,
  POSTHOG_FRONTEND_CLIENT_PLUGIN_TYPE,
  parsePostHogFrontendClientPluginConfig,
} from "./frontend-client-plugin"

export const buildPostHogFrontendClientPluginManifest = (options: {
  readonly apiKey: string
  readonly host: string
  readonly path: string
  readonly enabled?: boolean
}): OrganisationFrontendPluginManifestClientPlugin => {
  const config = parsePostHogFrontendClientPluginConfig(
    {
      apiKey: options.apiKey,
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
