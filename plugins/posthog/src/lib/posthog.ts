import { readConfiguration } from "@processfocus/runtime"
import { Construct, type IConstruct } from "constructs"
import { ConfigProvider, Effect } from "effect"
import { FRONTEND_PLUGIN_HOST_INTERFACE_VERSION } from "@pf/frontend-plugin-host"
import type {
  OrganisationBrowserPluginArtifactProvider,
  OrganisationBrowserPluginBuildInput,
  OrganisationFrontendManifestPluginCategory,
  OrganisationFrontendPluginManifestClientPlugin,
  OrganisationFrontendPluginManifestProvider,
} from "@pf/process/organisation-frontend-plugin-manifest"
import { buildPostHogFrontendClientPluginManifest } from "./frontend-client-plugin-manifest"
import type { makePostHogConfiguration } from "./posthog-configuration"

export type PostHogProps =
  | { readonly configuration: ReturnType<typeof makePostHogConfiguration> }
  | {
      readonly apiKey: string
      readonly host: string
      /** Defaults to disabled in local development. */
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
  readonly apiKey: string
  readonly host: string
  readonly enabled: boolean | undefined

  constructor(scope: IConstruct, id: string, props: PostHogProps) {
    super(scope, id)

    const values =
      "configuration" in props
        ? Effect.runSync(
            readConfiguration(props.configuration).pipe(
              Effect.provideService(
                ConfigProvider.ConfigProvider,
                ConfigProvider.fromEnv(),
              ),
            ),
          )
        : props
    this.apiKey =
      "configuration" in props && values.apiKey === ""
        ? ""
        : ensureNonEmptyString(values.apiKey, "apiKey")
    this.host = this.apiKey === "" ? "" : normalizeHost(values.host)
    this.enabled = values.enabled
    if (
      this.apiKey !== "" &&
      (this.enabled === true ||
        (this.enabled !== false && process.env["NODE_ENV"] !== "development"))
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
