import { readAuthPort } from "@pf/frontend-endpoints/port-files"

/**
 * Resolve the OAuth issuer URL for frontend JWT creation.
 *
 * Resolution order:
 * 1. OAUTH_ISSUER_URL env var (if set)
 * 2. Auth port from .auth-port.json file -> http://localhost:<port>
 * 3. Fallback: http://localhost:4020
 *
 * Steps 2 and 3 are local-dev-only fallbacks. A warning is emitted
 * so that accidental use in staging/production is visible.
 */
export const resolveIssuerUrl = (): string => {
  const envUrl = process.env["OAUTH_ISSUER_URL"]
  if (envUrl) return envUrl

  const port = readAuthPort()
  const url = `http://localhost:${port}`
  console.warn(
    `⚠️  OAUTH_ISSUER_URL not set — falling back to ${url} (local dev only)`,
  )
  return url
}
