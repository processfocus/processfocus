import {
  ORGANISATION_FRONTEND_MANIFEST_VERSION,
  type OrganisationFrontendManifest,
  type OrganisationFrontendManifestAnalyticsPlugin,
  parseOrganisationFrontendManifest,
} from "@pf/frontend-manifest"
import type { EmbedManifestEntry } from "./embed-manifest"

type FrontendManifestEmbedEntry = EmbedManifestEntry

export type FrontendManifest = Omit<OrganisationFrontendManifest, "embed"> & {
  readonly embed: {
    readonly entries: readonly FrontendManifestEmbedEntry[]
  }
}
export type FrontendManifestAnalyticsPlugin =
  OrganisationFrontendManifestAnalyticsPlugin
export type FrontendManifestPlugins = FrontendManifest["plugins"]

export const disabledFrontendManifest: FrontendManifest = {
  version: ORGANISATION_FRONTEND_MANIFEST_VERSION,
  organisation: {
    name: "Process Focus",
  },
  appIcons: {
    metadata: [],
    manifest: [],
  },
  publicFormBranding: null,
  embed: {
    entries: [],
  },
  processes: {
    documentation: [],
  },
  plugins: {
    analytics: [],
    formComponents: [],
  },
}

export const parseFrontendManifest = parseOrganisationFrontendManifest
