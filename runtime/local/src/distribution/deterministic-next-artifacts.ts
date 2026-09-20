import { createHash } from "node:crypto"

const dynamicRouteParameterToken = /%%drp:([^:%]+):[0-9a-f]+%%/g

/**
 * Next creates fallback-route parameter sentinels with Math.random() while it
 * prerenders dynamic routes. The values are opaque, but make otherwise
 * identical standalone dashboard builds differ byte-for-byte. Replace only
 * the random suffix with a value derived from the reviewed dashboard build ID.
 */
export const normalizeNextDynamicRouteParameterTokens = (
  content: string,
  buildId: string,
): string => {
  const stableSuffix = createHash("sha256")
    .update(`processfocus-dashboard:${buildId}`)
    .digest("hex")
    .slice(0, 13)

  return content.replace(
    dynamicRouteParameterToken,
    (_token, parameterName: string) =>
      `%%drp:${parameterName}:${stableSuffix}%%`,
  )
}

const normalizeNextPostponedState = (
  state: string,
  buildId: string,
): string => {
  const postponedLengthMatch = /^([0-9]+):/.exec(state)
  if (!postponedLengthMatch) {
    return normalizeNextDynamicRouteParameterTokens(state, buildId)
  }

  const postponedLengthText = postponedLengthMatch[1]
  if (postponedLengthText === undefined) {
    return normalizeNextDynamicRouteParameterTokens(state, buildId)
  }
  const postponedLength = Number.parseInt(postponedLengthText, 10)
  const postponedStart = postponedLengthMatch[0].length
  const postponedEnd = postponedStart + postponedLength
  if (postponedEnd > state.length) {
    return normalizeNextDynamicRouteParameterTokens(state, buildId)
  }

  const postponed = state.slice(postponedStart, postponedEnd)
  const resumeDataCache = normalizeNextDynamicRouteParameterTokens(
    state.slice(postponedEnd),
    buildId,
  )
  const replacementsLengthMatch = /^([0-9]+)/.exec(postponed)

  let normalizedPostponed: string
  if (!replacementsLengthMatch) {
    normalizedPostponed = normalizeNextDynamicRouteParameterTokens(
      postponed,
      buildId,
    )
  } else {
    const replacementsLengthText = replacementsLengthMatch[1]
    if (replacementsLengthText === undefined) {
      return normalizeNextDynamicRouteParameterTokens(state, buildId)
    }
    const replacementsLength = Number.parseInt(replacementsLengthText, 10)
    const replacementsStart = replacementsLengthMatch[0].length
    const replacementsEnd = replacementsStart + replacementsLength
    const replacements = normalizeNextDynamicRouteParameterTokens(
      postponed.slice(replacementsStart, replacementsEnd),
      buildId,
    )
    const data = normalizeNextDynamicRouteParameterTokens(
      postponed.slice(replacementsEnd),
      buildId,
    )
    normalizedPostponed = `${replacements.length}${replacements}${data}`
  }

  return `${normalizedPostponed.length}:${normalizedPostponed}${resumeDataCache}`
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const normalizeNextMetadata = (
  content: string,
  buildId: string,
): string => {
  const metadata: unknown = JSON.parse(content)
  if (!isRecord(metadata) || typeof metadata["postponed"] !== "string") {
    return normalizeNextDynamicRouteParameterTokens(content, buildId)
  }

  const postponed = normalizeNextPostponedState(metadata["postponed"], buildId)
  if (postponed === metadata["postponed"]) return content

  return `${JSON.stringify({ ...metadata, postponed }, null, 2)}\n`
}
