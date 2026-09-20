import { requestGoogleDriveAccessToken } from "./google-drive-oauth"
import { GOOGLE_DRIVE_PICKER_SCOPE } from "./google-drive-provider"
import type { Google, TokenClientConfig } from "./types"
import { describe, expect, it } from "bun:test"

const createGoogle = () => {
  let tokenClientConfig: TokenClientConfig | undefined
  let requestConfig: { readonly prompt?: string } | undefined
  const google: Google = {
    accounts: {
      oauth2: {
        initTokenClient: (config) => {
          tokenClientConfig = config
          return {
            requestAccessToken: (configOverride) => {
              requestConfig = configOverride
            },
          }
        },
      },
    },
  }
  return {
    google,
    getTokenClientConfig: () => tokenClientConfig,
    getRequestConfig: () => requestConfig,
  }
}

describe("Google Drive browser authorization", () => {
  it("requests a least-privilege Drive grant without forcing consent", () => {
    const { google, getTokenClientConfig, getRequestConfig } = createGoogle()

    requestGoogleDriveAccessToken({
      google,
      clientId: "client-id",
      onResponse: () => undefined,
      onError: () => undefined,
    })

    expect(getTokenClientConfig()).toMatchObject({
      client_id: "client-id",
      scope: GOOGLE_DRIVE_PICKER_SCOPE,
      include_granted_scopes: false,
    })
    expect(getTokenClientConfig()).not.toHaveProperty("hint")
    expect(getTokenClientConfig()).not.toHaveProperty("prompt")
    expect(getRequestConfig()).toBeUndefined()
  })

  it("hints GIS at the signed-in Google account", () => {
    const { google, getTokenClientConfig } = createGoogle()

    requestGoogleDriveAccessToken({
      google,
      clientId: "client-id",
      hint: "teacher@example.com",
      onResponse: () => undefined,
      onError: () => undefined,
    })

    expect(getTokenClientConfig()).toMatchObject({
      client_id: "client-id",
      hint: "teacher@example.com",
    })
  })
})
