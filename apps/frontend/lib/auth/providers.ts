import { cacheTag } from "next/cache"
import { getIssuerUrl } from "@/lib/auth/client"

const JWKS_PATH = "/.well-known/jwks.json"
const OAUTH_METADATA_PATH = "/.well-known/oauth-authorization-server"

interface OAuthMetadata {
  providers_supported?: string[]
  passkey_open_registration?: boolean
}

export interface LoginAuthProviders {
  readonly providers: readonly string[]
  /**
   * When true, the login page may offer Passkey Open Registration.
   * When false, self-registration is hidden (invite-only).
   */
  readonly passkeyOpenRegistration: boolean
}

/**
 * Fetch login-page auth metadata: provider list and Open Registration flag.
 *
 * Throws on error so transient failures are not baked into the cache.
 * Callers should catch and degrade gracefully.
 */
export async function getLoginAuthProviders(): Promise<LoginAuthProviders> {
  "use cache"
  cacheTag("login-page")

  const jwksUri = process.env["JWKS_URI"]
  const metadataBaseUrl = jwksUri?.endsWith(JWKS_PATH)
    ? jwksUri.slice(0, -JWKS_PATH.length)
    : getIssuerUrl()

  const response = await fetch(`${metadataBaseUrl}${OAUTH_METADATA_PATH}`)

  if (!response.ok) {
    throw new Error(
      `[auth/providers] OAuth metadata fetch failed: ${response.status}`,
    )
  }

  const metadata: OAuthMetadata = await response.json()
  const providers = metadata.providers_supported ?? []
  return {
    providers,
    passkeyOpenRegistration:
      providers.includes("passkey") &&
      metadata.passkey_open_registration === true,
  }
}
