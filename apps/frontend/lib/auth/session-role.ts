import type { Session } from "@pf/auth-session"

export function getActiveRoleCacheKey(session: Pick<Session, "roles">): string {
  // Auth sessions encode the active role as the first role in the token.
  return session.roles?.[0] ?? "no-role"
}
