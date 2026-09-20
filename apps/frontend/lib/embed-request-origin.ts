const parseOrigin = (value: string): string | null => {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

const getRequestOrigin = (headers: Pick<Headers, "get">): string | null => {
  const originHeader = headers.get("origin")
  if (originHeader) {
    return parseOrigin(originHeader)
  }

  const refererHeader = headers.get("referer")
  if (refererHeader) {
    // Browsers send Origin for normal cross-site iframe POSTs. Keep Referer as a
    // fallback for same-origin/dev cases, but treat it only as a best-effort origin.
    return parseOrigin(refererHeader)
  }

  return null
}

export const isAllowedEmbedOrigin = (
  headers: Pick<Headers, "get">,
  allowedSites: readonly string[],
  frontendOrigin?: string,
): boolean => {
  const requestOrigin = getRequestOrigin(headers)

  if (requestOrigin === null) {
    return false
  }

  return (
    requestOrigin === frontendOrigin || allowedSites.includes(requestOrigin)
  )
}
