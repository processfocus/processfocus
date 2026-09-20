import type { OrganisationFrontendPlugin } from "@pf/frontend-plugin-host"
import type { FrontendPluginLoaderMap } from "./frontend-plugin-loaders"

export interface OrganisationFrontendPluginHost {
  readonly activate: (
    manifestType: string,
    plugin: OrganisationFrontendPlugin,
  ) => Promise<void>
}

export const createOrganisationFrontendPluginLoaders = (
  _host: OrganisationFrontendPluginHost,
): FrontendPluginLoaderMap => ({})
