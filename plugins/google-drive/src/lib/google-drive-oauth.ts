import { GOOGLE_DRIVE_PICKER_SCOPE } from "./google-drive-provider"
import type { Google, TokenResponse } from "./types"

interface RequestGoogleDriveAccessTokenInput {
  readonly google: Google
  readonly clientId: string
  readonly hint?: string
  readonly onResponse: (response: TokenResponse) => void
  readonly onError: () => void
}

export const requestGoogleDriveAccessToken = ({
  google,
  clientId,
  hint,
  onResponse,
  onError,
}: RequestGoogleDriveAccessTokenInput): void => {
  const tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: GOOGLE_DRIVE_PICKER_SCOPE,
    include_granted_scopes: false,
    callback: onResponse,
    error_callback: onError,
    ...(hint !== undefined && hint !== "" && { hint }),
  })
  tokenClient.requestAccessToken()
}
