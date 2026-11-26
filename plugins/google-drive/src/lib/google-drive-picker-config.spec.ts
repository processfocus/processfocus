import { ConfigurationError } from "@processfocus/runtime"
import { readGoogleDrivePickerConfiguration } from "./google-drive-configuration"
import {
  GOOGLE_DRIVE_NOT_CONFIGURED_USER_MESSAGE,
  googleDrivePickerConfigurationDiagnostics,
} from "./google-drive-picker-config"
import { afterEach, describe, expect, it } from "bun:test"

const pickerEnvKeys = [
  "GOOGLE_DRIVE_PICKER_CLIENT_ID",
  "GOOGLE_DRIVE_PICKER_APP_ID",
  "GOOGLE_DRIVE_PICKER_DEVELOPER_KEY",
] as const

const originalPickerEnv = Object.fromEntries(
  pickerEnvKeys.map((key) => [key, process.env[key]]),
)

const restorePickerEnv = (): void => {
  for (const key of pickerEnvKeys) {
    const original = originalPickerEnv[key]
    if (original === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = original
    }
  }
}

const clearPickerEnv = (): void => {
  for (const key of pickerEnvKeys) {
    delete process.env[key]
  }
}

afterEach(() => {
  restorePickerEnv()
})

describe("Google Drive Picker configuration", () => {
  it("reads canonical GOOGLE_DRIVE_PICKER_* names", () => {
    clearPickerEnv()
    process.env["GOOGLE_DRIVE_PICKER_CLIENT_ID"] = "canonical-client"
    process.env["GOOGLE_DRIVE_PICKER_APP_ID"] = "canonical-app"
    process.env["GOOGLE_DRIVE_PICKER_DEVELOPER_KEY"] = "canonical-key"

    expect(readGoogleDrivePickerConfiguration()).toEqual({
      clientId: "canonical-client",
      appId: "canonical-app",
      developerKey: "canonical-key",
    })
  })

  it("treats absent Picker settings as unconfigured", () => {
    clearPickerEnv()

    expect(readGoogleDrivePickerConfiguration()).toEqual({
      clientId: "",
      appId: "",
      developerKey: "",
    })
  })

  it.each(["   "])("rejects blank Picker settings (%s)", (value) => {
    clearPickerEnv()
    process.env["GOOGLE_DRIVE_PICKER_CLIENT_ID"] = value
    expect(() => readGoogleDrivePickerConfiguration()).toThrow(
      ConfigurationError,
    )
  })

  it("describes missing values as Picker configuration without logging them", () => {
    const diagnostics = googleDrivePickerConfigurationDiagnostics({
      clientId: "",
      appId: "drive-app",
      developerKey: "drive-developer-key",
    })

    expect(diagnostics).toEqual([
      "Google Drive Picker: Missing GOOGLE_DRIVE_PICKER_CLIENT_ID Picker configuration",
    ])
    expect(diagnostics.join("\n")).not.toContain("drive-app")
    expect(diagnostics.join("\n")).not.toContain("drive-developer-key")
    expect(diagnostics.join("\n").toLowerCase()).not.toContain("credential")
  })

  it("keeps the form-user message free of environment-variable names", () => {
    expect(GOOGLE_DRIVE_NOT_CONFIGURED_USER_MESSAGE).toBe(
      "Google Drive is not configured. Contact your administrator.",
    )
    expect(GOOGLE_DRIVE_NOT_CONFIGURED_USER_MESSAGE).not.toContain(
      "GOOGLE_DRIVE_",
    )
  })
})
