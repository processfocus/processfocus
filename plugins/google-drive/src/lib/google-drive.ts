import { Construct } from "constructs"
import { FRONTEND_PLUGIN_HOST_INTERFACE_VERSION } from "@pf/frontend-plugin-host"
import type {
  OrganisationBrowserPluginArtifactProvider,
  OrganisationBrowserPluginBuildInput,
  OrganisationFrontendManifestPluginCategory,
  OrganisationFrontendPluginManifestClientPlugin,
  OrganisationFrontendPluginManifestProvider,
} from "@pf/process/organisation-frontend-plugin-manifest"
import {
  GOOGLE_DRIVE_CLIENT_MODULE,
  GOOGLE_DRIVE_PLUGIN_TYPE,
} from "./plugin-identity"

/**
 * Declares Google Drive as organisation-owned browser and server behavior.
 *
 * Importing the plugin's field API registers its walker in the organisation
 * bundle realm. This construct makes the matching browser renderer and its
 * build-time stylesheet part of the same organisation artifact.
 */
export class GoogleDrive
  extends Construct
  implements
    OrganisationFrontendPluginManifestProvider,
    OrganisationBrowserPluginArtifactProvider
{
  readonly isFrontendClientPluginManifestProvider = true as const
  readonly isBrowserPluginArtifactProvider = true as const
  readonly frontendManifestPluginCategory =
    "formComponents" satisfies OrganisationFrontendManifestPluginCategory

  buildFrontendClientPluginManifest(): OrganisationFrontendPluginManifestClientPlugin {
    return {
      module: GOOGLE_DRIVE_CLIENT_MODULE,
      type: GOOGLE_DRIVE_PLUGIN_TYPE,
      config: null,
    }
  }

  buildBrowserPluginArtifact(): OrganisationBrowserPluginBuildInput {
    return {
      identity: GOOGLE_DRIVE_PLUGIN_TYPE,
      category: "formComponents",
      hostInterfaceVersion: FRONTEND_PLUGIN_HOST_INTERFACE_VERSION,
      entrypoint: "@processfocus/plugin-google-drive/browser",
      preparation: {
        kind: "stylesheet",
        entrypoint: "@processfocus/plugin-google-drive/styles.css",
      },
    }
  }
}
