import type { Session } from "./subjects"

/** Effective identity only: refresh expiry and display names do not reset data. */
export function getSessionCacheScope(session: Session): string {
  return JSON.stringify([
    session.userId,
    "email" in session
      ? session.delegation
        ? [
            "delegation",
            session.delegation.id,
            session.delegation.generationId,
            session.delegation.expiresAt,
          ]
        : ["human", session.email]
      : ["service", session.clientId],
    session.orgUnitId,
    session.orgUnitPath,
    [...(session.roles ?? [])].sort(),
    "email" in session && session.delegationRoleSelection !== undefined
      ? [...session.delegationRoleSelection].sort()
      : null,
  ])
}
