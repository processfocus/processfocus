import { Construct } from "constructs"
import type {
  OrganisationBrowserPluginArtifactProvider,
  OrganisationFrontendPluginManifestProvider,
} from "processfocus/plugin"

export class CustomFieldPlugin
  extends Construct
  implements
    OrganisationBrowserPluginArtifactProvider,
    OrganisationFrontendPluginManifestProvider
{
  readonly isFrontendClientPluginManifestProvider = true
  readonly isBrowserPluginArtifactProvider = true
  readonly frontendManifestPluginCategory = "formComponents" as const
  buildFrontendClientPluginManifest() {
    return {
      module: "./src/custom-field-client.tsx",
      type: "fixture-custom-field",
      config: null,
    }
  }
  buildBrowserPluginArtifact() {
    return {
      identity: "fixture-custom-field",
      category: "formComponents" as const,
      hostInterfaceVersion: 1,
      entrypoint: "./src/custom-field-client.tsx",
    }
  }
}
