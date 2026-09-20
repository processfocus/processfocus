/**
 * Validates and sanitizes a redirect URL to prevent open redirect attacks.
 *
 * Rules:
 * - Must be a relative path (starts with /)
 * - Must not be a protocol-relative URL (starts with //)
 * - Must not redirect to API routes
 * - Must not redirect to login/logout pages
 *
 * @param redirect - A root-relative URL with escaped components, or a legacy
 * whole-URL-encoded value. Once the leading / is exposed, component escapes
 * are preserved. The returned URL is safe to validate again.
 * @returns An object with the validated redirect URL and whether it was rejected
 */
export function validateRedirect(redirect: string | undefined | null): {
  url: string
  rejected: boolean
  reason?: string
} {
  if (!redirect) return { url: "/", rejected: false }

  const MAX_DECODE_ITERATIONS = 5
  let canonical = redirect
  try {
    // Preserve the shipped whole-path encoding API without decoding query data.
    for (let i = 0; !canonical.startsWith("/"); i++) {
      if (i === MAX_DECODE_ITERATIONS) {
        return { url: "/", rejected: true, reason: "excessive_encoding" }
      }
      const next = decodeURIComponent(canonical)
      if (next === canonical) break
      canonical = next
    }
    // Check encoding syntax, but never use decoded query/fragment values as URLs.
    decodeURIComponent(canonical)
  } catch {
    return { url: "/", rejected: true, reason: "invalid_encoding" }
  }

  // Decode only a separate pathname for conservative security inspection.
  let decoded = canonical.split(/[?#]/, 1)[0] ?? ""
  try {
    for (let i = 0; i < MAX_DECODE_ITERATIONS; i++) {
      const next = decodeURIComponent(decoded)
      if (next === decoded) break // No more encoding to decode
      decoded = next
      if (i === MAX_DECODE_ITERATIONS - 1) {
        // Still changing after max iterations - reject
        return { url: "/", rejected: true, reason: "excessive_encoding" }
      }
    }
  } catch {
    // Invalid encoding, reject
    return { url: "/", rejected: true, reason: "invalid_encoding" }
  }

  // Must start with / (relative path)
  if (!decoded.startsWith("/")) {
    return { url: "/", rejected: true, reason: "not_relative_path" }
  }

  // Must not be protocol-relative URL (//evil.com)
  if (decoded.startsWith("//")) {
    return { url: "/", rejected: true, reason: "protocol_relative" }
  }

  if (
    decoded.includes("\\") ||
    [...decoded, ...canonical].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  ) {
    return { url: "/", rejected: true, reason: "host_manipulation" }
  }

  // Check both normalized pathnames: decoding %3F/%23 can hide traversal in
  // an apparent query/fragment that is still part of the canonical pathname.
  try {
    for (const candidate of [canonical, decoded]) {
      const asUrl = new URL(candidate, "http://localhost")
      if (asUrl.origin !== "http://localhost") {
        return { url: "/", rejected: true, reason: "host_manipulation" }
      }
      if (asUrl.pathname.startsWith("/api/")) {
        return { url: "/", rejected: true, reason: "api_route" }
      }
      if (asUrl.pathname === "/login" || asUrl.pathname === "/logout") {
        return { url: "/", rejected: true, reason: "auth_route" }
      }
    }
  } catch {
    return { url: "/", rejected: true, reason: "invalid_url" }
  }

  return { url: canonical, rejected: false }
}

/**
 * Simple version that just returns the URL string.
 * Use validateRedirect when you need to log rejections.
 */
export function getValidRedirect(redirect: string | undefined | null): string {
  return validateRedirect(redirect).url
}
