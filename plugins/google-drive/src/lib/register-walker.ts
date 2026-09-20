import { registerWalkerPlugin } from "@processfocus/runtime"
import {
  FormGoogleDriveGeneratePdf,
  FormGoogleDriveInput,
} from "./google-drive-annotations"
import { readGoogleDrivePickerConfiguration } from "./google-drive-picker-config"
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
export const registerGoogleDriveWalkerPlugin = (): void => {
  registerWalkerPlugin({
    type: GOOGLE_DRIVE_PLUGIN_TYPE,
    matchAnnotation(annotations: Record<symbol, unknown>): boolean {
      return annotations[FormGoogleDriveInput] === true
    },
    extractData(annotations: Record<symbol, unknown>): GoogleDrivePluginData {
      // Public Picker configuration is read here on the server and sent to the
      // renderer through field pluginData. These values are not secrets.
      const { clientId, appId, developerKey } =
        readGoogleDrivePickerConfiguration()
      const generatePdf = annotations[FormGoogleDriveGeneratePdf]
      return {
        ...(clientId !== undefined && { clientId }),
        ...(appId !== undefined && { appId }),
        ...(developerKey !== undefined && { developerKey }),
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
