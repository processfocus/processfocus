import type { Session } from "@pf/auth-session"

/** Consistency check only. The server still verifies and authorizes the JWT. */
export function matchesRealtimeSessionToken(
  token: string | undefined,
  session: Session,
  expiresAt: number,
): boolean {
  try {
    const payload = token?.split(".")[1]
    if (!payload) return false
    const decoded: unknown = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(
          atob(payload.replaceAll("-", "+").replaceAll("_", "/")),
          (character) => character.charCodeAt(0),
        ),
      ),
    )
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      !("exp" in decoded) ||
      decoded.exp !== expiresAt ||
      !Number.isSafeInteger(expiresAt) ||
      Date.now() >= expiresAt * 1000 ||
      !("properties" in decoded)
    )
      return false
    const properties = decoded.properties
    if (typeof properties !== "object" || properties === null) return false
    // Compare only addressing facts, not human authentication evidence omitted
    // from the browser session. Never project a missing delegation into a human.
    const delegation: unknown = Reflect.get(properties, "delegation")
    const expected = "clientId" in session ? undefined : session.delegation
    if (expected) {
      if (
        typeof delegation !== "object" ||
        delegation === null ||
        !["id", "generationId", "name", "expiresAt"].every(
          (key) => Reflect.get(delegation, key) === Reflect.get(expected, key),
        )
      )
        return false
    } else if (delegation !== undefined) return false
    return [
      "userId",
      "clientId",
      "email",
      "roles",
      "orgUnitId",
      "orgUnitPath",
      "delegationRoleSelection",
    ].every(
      (key) =>
        JSON.stringify(Reflect.get(properties, key)) ===
        JSON.stringify(Reflect.get(session, key)),
    )
  } catch {
    return false
  }
}
