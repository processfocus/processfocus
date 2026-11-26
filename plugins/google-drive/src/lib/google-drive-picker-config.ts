import type { GoogleDrivePluginData } from "./plugin-data"

export const GOOGLE_DRIVE_NOT_CONFIGURED_USER_MESSAGE =
  "Google Drive is not configured. Contact your administrator."

export type GoogleDrivePickerConfiguration = Pick<
  GoogleDrivePluginData,
  "clientId" | "appId" | "developerKey"
>

export const googleDrivePickerConfigurationDiagnostics = (input: {
  readonly clientId: string
  readonly appId: string
  readonly developerKey: string
}): readonly string[] => {
  const diagnostics: string[] = []
  if (!input.clientId) {
    diagnostics.push(
      "Google Drive Picker: Missing GOOGLE_DRIVE_PICKER_CLIENT_ID Picker configuration",
    )
  }
  if (!input.appId) {
    diagnostics.push(
      "Google Drive Picker: Missing GOOGLE_DRIVE_PICKER_APP_ID Picker configuration",
    )
  }
  if (!input.developerKey) {
    diagnostics.push(
      "Google Drive Picker: Missing GOOGLE_DRIVE_PICKER_DEVELOPER_KEY Picker configuration",
    )
  }
  return diagnostics
}
