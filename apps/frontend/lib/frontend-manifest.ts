import {
  type ClientFormDefinition,
  parseNullableClientFormDefinition,
} from "@pf/form-client-representation/client-form-definition"
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

export const parseFrontendManifest = (value: unknown): FrontendManifest => {
  const manifest = parseOrganisationFrontendManifest(value)
  return {
    ...manifest,
    embed: {
      entries: manifest.embed.entries.map((entry, index) => {
        const formDefinition: ClientFormDefinition | null =
          parseNullableClientFormDefinition(
            entry.formDefinition,
            `embed.entries[${index}].formDefinition`,
          )

        return {
          stepPath: entry.stepPath,
          processName: entry.processName,
          processPath: entry.processPath,
          mutationName: entry.mutationName,
          inputTypeName: entry.inputTypeName,
          totalFields: entry.totalFields,
          formDefinition,
          defaultValues: entry.defaultValues,
          jsonSchema: entry.jsonSchema,
          sites: entry.sites,
          thankYou: entry.thankYou,
        }
      }),
    },
  }
}
