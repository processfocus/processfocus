import { type Client, createClient } from "@pf/openauth/client"
import {
  getFrontendAuthClientConfig,
  getIssuerUrl,
  validateFrontendJwtIssuer,
} from "./issuer"

export { getIssuerUrl, validateFrontendJwtIssuer }

const AUTH_CLIENT_CACHE_MS = 60 * 10 * 1000

interface CachedAuthClient {
  client: Client
  expiresAt: number
  jwt: string
  issuer: string
}

let cachedAuthClient: CachedAuthClient | undefined

export const getAuthClient = (): Client => {
  const { jwt, issuer } = getFrontendAuthClientConfig()
  const now = Date.now()

  if (
    cachedAuthClient &&
    cachedAuthClient.expiresAt > now &&
    cachedAuthClient.jwt === jwt &&
    cachedAuthClient.issuer === issuer
  ) {
    return cachedAuthClient.client
  }

  const client = createClient({
    jwt,
    issuer,
  })

  cachedAuthClient = {
    client,
    expiresAt: now + AUTH_CLIENT_CACHE_MS,
    jwt,
    issuer,
  }
  return client
}
