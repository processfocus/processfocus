import { Construct, type IConstruct } from "constructs"
import { Config } from "effect"
import { FRONTEND_PLUGIN_HOST_INTERFACE_VERSION } from "@pf/frontend-plugin-host"
import type {
  OrganisationBrowserPluginArtifactProvider,
  OrganisationBrowserPluginBuildInput,
  OrganisationFrontendManifestPluginCategory,
  OrganisationFrontendPluginManifestClientPlugin,
  OrganisationFrontendPluginManifestProvider,
} from "@pf/process/organisation-frontend-plugin-manifest"
import { buildPostHogFrontendClientPluginManifest } from "./frontend-client-plugin-manifest"

export interface PostHogProps {
  /**
   * The PostHog project API key (phc_...).
   * Can be an Effect Config for runtime resolution.
   */
  readonly apiKey: string | Config.Config<string>
  /**
   * The PostHog ingestion host
   * (e.g. "https://us.i.posthog.com").
   * Must be a valid http(s) URL.
   */
  readonly host: string
  /**
   * Explicitly override whether PostHog is enabled.
   *
   * When omitted, PostHog uses the environment default: enabled outside local
   * development and disabled when `NODE_ENV === "development"`.
   *
   * Set to `true` to enable PostHog everywhere, including local development.
   * Set to `false` to disable PostHog everywhere, even if the frontend manifest
   * contains a PostHog analytics entry.
   */
  readonly enabled?: boolean
}

const ensureNonEmptyString = (value: string, field: string): string => {
  const normalized = value.trim()

  if (normalized.length === 0) {
    throw new Error(`PostHog ${field} must be a non-empty string`)
  }

  return normalized
}

const normalizeHost = (host: string): string => {
  const normalized = ensureNonEmptyString(host, "host").replace(/\/+$/, "")

  let parsed: URL

  try {
    parsed = new URL(normalized)
  } catch {
    throw new Error(`PostHog host must be a valid http(s) URL, got: ${host}`)
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`PostHog host must be a valid http(s) URL, got: ${host}`)
  }

  return normalized
}

export class PostHog
  extends Construct
  implements
    OrganisationFrontendPluginManifestProvider,
    OrganisationBrowserPluginArtifactProvider
{
  readonly isFrontendClientPluginManifestProvider = true as const
  readonly isBrowserPluginArtifactProvider = true as const
  readonly frontendManifestPluginCategory?: OrganisationFrontendManifestPluginCategory
  readonly apiKey: string | Config.Config<string>
  readonly host: string
  readonly enabled: boolean | undefined

  constructor(scope: IConstruct, id: string, props: PostHogProps) {
    super(scope, id)

    this.apiKey = Config.isConfig(props.apiKey)
      ? props.apiKey
      : ensureNonEmptyString(props.apiKey, "apiKey")
    this.host = normalizeHost(props.host)
    this.enabled = props.enabled
    if (
      props.enabled === true ||
      (props.enabled !== false && process.env["NODE_ENV"] !== "development")
    ) {
      this.frontendManifestPluginCategory = "analytics"
    }
  }

  buildFrontendClientPluginManifest(): OrganisationFrontendPluginManifestClientPlugin {
    return buildPostHogFrontendClientPluginManifest({
      apiKey: this.apiKey,
      host: this.host,
      ...(this.enabled !== undefined ? { enabled: this.enabled } : {}),
      path: this.node.path,
    })
  }

  buildBrowserPluginArtifact(): OrganisationBrowserPluginBuildInput {
    return {
      identity: "analytics.posthog",
      category: "analytics",
      hostInterfaceVersion: FRONTEND_PLUGIN_HOST_INTERFACE_VERSION,
      entrypoint: "@processfocus/plugin-posthog/browser",
    }
  }
}
