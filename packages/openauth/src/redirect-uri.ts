/**
 * Redirect URI validation and normalization utilities.
 * @packageDocumentation
 */

/**
 * Normalize path for comparison by removing trailing slash.
 */
function normalizePathForComparison(origin: string, pathname: string): string {
  const base = `${origin}${pathname}`
  return base.endsWith("/") ? base.slice(0, -1) : base
}

/**
 * Normalize a redirect URI.
 * Returns Result-like object for safe error handling.
 *
 * @param uri - The redirect URI to normalize
 * @returns Object with ok:true and normalized value, or ok:false on invalid URI
 */
export function tryNormalizeRedirectUri(
  uri: string,
): { ok: true; value: string } | { ok: false } {
  try {
    const parsed = new URL(uri)
    if (parsed.hash) {
      return { ok: false }
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { ok: false }
    }
    return { ok: true, value: parsed.toString() }
  } catch {
    return { ok: false }
  }
}

/**
 * Normalize a redirect URI, throwing on invalid input.
 * Use when registering client redirect URIs (configuration-time validation).
 *
 * @param uri - The redirect URI to normalize
 * @returns Normalized URI string
 * @throws Error if URI is invalid
 */
export function normalizeRedirectUri(uri: string): string {
  const parsed = new URL(uri)
  if (parsed.hash) {
    throw new Error(`Redirect URI must not contain a fragment: ${uri}`)
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Redirect URI must use http or https: ${uri}`)
  }
  return parsed.toString()
}

/**
 * Check if a redirect URI matches one of the registered URIs.
 * Comparison ignores query strings and trailing slashes.
 *
 * Special case: `http://localhost` (without port) matches any `http://localhost:*` URL.
 * This allows wildcard localhost redirects for local development.
 *
 * @param redirectUri - The redirect URI to validate
 * @param registeredUris - List of registered redirect URIs for the client
 * @returns true if the redirect URI is valid
 */
export function isValidRedirectUri(
  redirectUri: string,
  registeredUris: readonly string[],
): boolean {
  const normalizeResult = tryNormalizeRedirectUri(redirectUri)
  if (!normalizeResult.ok) {
    return false
  }

  const parsedUri = new URL(normalizeResult.value)
  const normalizedBase = normalizePathForComparison(
    parsedUri.origin,
    parsedUri.pathname,
  )

  return registeredUris.some((registered) => {
    const parsedRegistered = new URL(registered)

    // Special case: http://localhost (without port) matches any localhost port
    if (
      parsedRegistered.protocol === "http:" &&
      parsedRegistered.hostname === "localhost" &&
      parsedRegistered.port === "" &&
      parsedUri.protocol === "http:" &&
      parsedUri.hostname === "localhost"
    ) {
      const registeredPath = normalizePathForComparison(
        parsedRegistered.origin,
        parsedRegistered.pathname,
      )
      const requestPath = normalizePathForComparison(
        "http://localhost",
        parsedUri.pathname,
      )
      return registeredPath === requestPath
    }

    const registeredBase = normalizePathForComparison(
      parsedRegistered.origin,
      parsedRegistered.pathname,
    )
    return registeredBase === normalizedBase
  })
}
