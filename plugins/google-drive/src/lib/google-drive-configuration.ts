import {
  type ConfigurationGroup,
  configurationField,
  configurationString,
  readConfiguration,
} from "@processfocus/runtime"
import { Config, ConfigProvider, Effect } from "effect"
import type { GoogleDrivePickerConfiguration } from "./google-drive-picker-config"

export const makeGoogleDriveConfiguration = (
  bindings: {
    readonly clientId?: string
    readonly appId?: string
    readonly developerKey?: string
  } = {},
) => {
  const clientId = bindings.clientId ?? "GOOGLE_DRIVE_PICKER_CLIENT_ID"
  const appId = bindings.appId ?? "GOOGLE_DRIVE_PICKER_APP_ID"
  const developerKey =
    bindings.developerKey ?? "GOOGLE_DRIVE_PICKER_DEVELOPER_KEY"
  // Absent values leave the picker unconfigured instead of blocking
  // deployment; supplied values must still be nonblank.
  const optionalPickerValue = (key: string) =>
    configurationString(key).pipe(Config.withDefault(""))
  return {
    owner: "form.google-drive",
    target: "form-projection",
    fields: {
      clientId: configurationField(clientId, optionalPickerValue(clientId)),
      appId: configurationField(appId, optionalPickerValue(appId)),
      developerKey: configurationField(
        developerKey,
        optionalPickerValue(developerKey),
      ),
    },
    rules: [],
  } satisfies ConfigurationGroup
}

export const GoogleDriveConfiguration = makeGoogleDriveConfiguration()

export const readGoogleDrivePickerConfiguration = (
  configuration = GoogleDriveConfiguration,
): GoogleDrivePickerConfiguration =>
  Effect.runSync(
    readConfiguration(configuration).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv(),
      ),
    ),
  )
