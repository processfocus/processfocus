/** Decode only an expiry hint; the API still verifies the JWT and live validity. */
export const credentialDeadline = (
  accessToken: string,
  expiresIn: number,
): number => {
  const now = Date.now()
  const relativeDeadline = new Date(now + expiresIn * 1000).getTime()
  if (
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0 ||
    !Number.isFinite(relativeDeadline) ||
    relativeDeadline <= now
  ) {
    throw new Error("Invalid login credential lifetime")
  }

  let payload: unknown
  try {
    const parts = accessToken.split(".")
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
      throw new Error("Invalid JWT")
    }
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
  } catch {
    throw new Error("Invalid login credential expiry")
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("exp" in payload) ||
    typeof payload.exp !== "number" ||
    !Number.isFinite(payload.exp)
  ) {
    throw new Error("Invalid login credential expiry")
  }
  const jwtDeadline = new Date(payload.exp * 1000).getTime()
  if (!Number.isFinite(jwtDeadline)) {
    throw new Error("Invalid login credential expiry")
  }
  const expiresAt = Math.min(relativeDeadline, jwtDeadline)
  if (expiresAt <= now) {
    throw new Error("Login expired. Run pfcli auth login again.")
  }
  return expiresAt
}
