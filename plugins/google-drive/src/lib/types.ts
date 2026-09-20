/**
 * Type definitions for Google Drive plugin
 */

/**
 * Google Identity Services token client types
 */

export interface TokenResponse {
  readonly access_token?: string
  readonly expires_in?: number
  readonly scope?: string
  readonly token_type?: string
  readonly error?: string
  readonly error_description?: string
}

export interface OverridableTokenClientConfig {
  readonly scope?: string
  readonly prompt?: string
  readonly login_hint?: string
}

export interface TokenClient {
  requestAccessToken(overrideConfig?: OverridableTokenClientConfig): void
}

export interface TokenClientConfig {
  client_id: string
  scope: string
  include_granted_scopes?: boolean
  callback: (response: TokenResponse) => void
  prompt?: string
  hint?: string
  error_callback?: (error: { type: string }) => void
}

export interface OAuth2 {
  initTokenClient(config: TokenClientConfig): TokenClient
}

export interface GoogleAccounts {
  oauth2: OAuth2
}

export interface Google {
  accounts: GoogleAccounts
}
