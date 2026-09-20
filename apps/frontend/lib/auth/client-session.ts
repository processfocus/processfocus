import type { Session } from "@pf/auth-session"
import type { SessionWithTokenAndExpiry } from "./session"

export function toClientSession(session: SessionWithTokenAndExpiry): Session {
  // `email` is the discriminator from `@pf/auth-session` subjects: provider
  // users have it, service users have `clientId` instead.
  if ("email" in session) {
    return {
      userId: session.userId,
      email: session.email,
      orgUnitId: session.orgUnitId,
      orgUnitPath: session.orgUnitPath,
      roles: session.roles,
      ...(session.delegation ? { delegation: session.delegation } : {}),
      ...(session.delegationRoleSelection !== undefined
        ? { delegationRoleSelection: session.delegationRoleSelection }
        : {}),
    }
  }

  return {
    userId: session.userId,
    clientId: session.clientId,
    ...(session.roles ? { roles: session.roles } : {}),
    ...(session.orgUnitId !== undefined
      ? { orgUnitId: session.orgUnitId }
      : {}),
    ...(session.orgUnitPath !== undefined
      ? { orgUnitPath: session.orgUnitPath }
      : {}),
  }
}
