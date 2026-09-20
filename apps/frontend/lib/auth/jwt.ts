/**
 * Decode JWT payload without verification (for extracting claims like exp).
 */
export const decodeJwtPayload = (
  token: string,
): { exp?: number; properties?: unknown } | null => {
  const payloadSegment = token.split(".")[1]
  if (!payloadSegment) return null

  try {
    return JSON.parse(
      Buffer.from(payloadSegment, "base64url").toString("utf-8"),
    )
  } catch {
    return null
  }
}
