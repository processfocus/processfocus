import { registerWalkerPlugin } from "@processfocus/runtime"
import {
  FormGoogleDriveGeneratePdf,
  FormGoogleDriveInput,
} from "./google-drive-annotations"
import {
  GoogleDriveConfiguration,
  readGoogleDrivePickerConfiguration,
} from "./google-drive-configuration"
import { clearPickerTokenCache } from "./picker-token-cache"
import type { GoogleDrivePluginData } from "./plugin-data"
import { GOOGLE_DRIVE_PLUGIN_TYPE } from "./plugin-identity"

/**
 * Register the Google Drive walker plugin only.
 *
 * Safe to call in any environment (server or client).
 * Does not import React components.
 *
 * **CSP requirements** — the external Google scripts need at minimum:
 * ```
 * script-src https://accounts.google.com https://apis.google.com;
 * frame-src  https://accounts.google.com https://docs.google.com https://drive.google.com;
 * connect-src https://accounts.google.com https://www.googleapis.com https://docs.google.com https://*.googleusercontent.com;
 * ```
 * SRI hashes are not applied because both endpoints serve version-less
 * bundles whose content changes without notice.
 */
export const registerGoogleDriveWalkerPlugin = (
  configuration = GoogleDriveConfiguration,
): void => {
  registerWalkerPlugin({
    type: GOOGLE_DRIVE_PLUGIN_TYPE,
    matchAnnotation(annotations: Record<symbol, unknown>): boolean {
      return annotations[FormGoogleDriveInput] === true
    },
    extractData(annotations: Record<symbol, unknown>): GoogleDrivePluginData {
      // Public Picker configuration is read here on the server and sent to the
      // renderer through field pluginData. These values are not secrets.
      // Unconfigured environments omit the values so forms degrade to the
      // "Google Drive is not configured" renderer state.
      const { clientId, appId, developerKey } =
        readGoogleDrivePickerConfiguration(configuration)
      const generatePdf = annotations[FormGoogleDriveGeneratePdf]
      return {
        ...(clientId !== "" && { clientId }),
        ...(appId !== "" && { appId }),
        ...(developerKey !== "" && { developerKey }),
        ...(typeof generatePdf === "object" &&
          generatePdf !== null &&
          "documentStore" in generatePdf &&
          typeof generatePdf.documentStore === "string" && {
            generatePdf: { documentStore: generatePdf.documentStore },
          }),
      }
    },
    scripts: [
      {
        id: "google-identity-services",
        src: "https://accounts.google.com/gsi/client",
        async: true,
      },
      {
        id: "google-api-loader",
        src: "https://apis.google.com/js/api.js",
        async: true,
      },
    ],
    cleanup: clearPickerTokenCache,
  })
}
