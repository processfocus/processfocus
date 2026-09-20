export const GRAPHQL_AUDIENCE = "graphql-api"

const parseAccessTokenPayload = (
  accessToken: string,
): Record<string, unknown> | undefined => {
  const payloadPart = accessToken.split(".")[1]
  if (!payloadPart) {
    return undefined
  }

  try {
    const normalized = payloadPart.replace(/-/g, "+").replace(/_/g, "/")
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<
      string,
      unknown
    >
  } catch {
    return undefined
  }
}

export const parseAccessTokenAudience = (
  accessToken: string,
): string | readonly string[] | undefined => {
  const payload = parseAccessTokenPayload(accessToken)
  if (!payload) {
    return undefined
  }

  if (typeof payload["aud"] === "string") {
    return payload["aud"]
  }

  if (
    Array.isArray(payload["aud"]) &&
    payload["aud"].every((value) => typeof value === "string")
  ) {
    return payload["aud"] as readonly string[]
  }

  return undefined
}

export const parseAccessTokenUserId = (
  accessToken: string,
): string | undefined => {
  const payload = parseAccessTokenPayload(accessToken)
  if (!payload) {
    return undefined
  }

  const properties =
    typeof payload["properties"] === "object" && payload["properties"] !== null
      ? (payload["properties"] as Record<string, unknown>)
      : undefined

  if (typeof properties?.["userId"] === "string") {
    return properties["userId"]
  }

  return typeof payload["sub"] === "string" ? payload["sub"] : undefined
}
