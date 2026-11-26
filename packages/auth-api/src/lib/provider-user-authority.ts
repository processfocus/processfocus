import { Effect, Option } from "effect"
import {
  type ActivePolicyRevision,
  type AuthorizationError,
  AuthorizationService,
  ProviderUserPrincipal,
  RoleRef,
} from "@pf/auth-policy"
import type { ProviderUserSession } from "@pf/auth-session"
import type { RequestTime } from "@pf/request-time"
import {
  AuthenticationDatabase,
  type DatabaseQueryError,
} from "./authentication-database"
import {
  type InvalidRolePreparation,
  checkProviderUserAssignments,
} from "./role-switch"

/** Revalidate selected authority after signature verification. Permanent rows confer no authority. */
export const checkProviderUserAuthority = (
  session: ProviderUserSession,
): Effect.Effect<
  boolean,
  AuthorizationError | DatabaseQueryError | InvalidRolePreparation,
  | ActivePolicyRevision
  | AuthenticationDatabase
  | AuthorizationService
  | RequestTime
> =>
  Effect.gen(function* () {
    if (!(yield* checkProviderUserAssignments(session))) return false
    const auth = yield* AuthorizationService
    const db = yield* AuthenticationDatabase
    const switchedRole =
      session.switchedRole ?? session.temporaryRoleAuthority?.role
    if (switchedRole) {
      const owner = yield* db.findProviderUserByUserId(session.userId)
      if (Option.isNone(owner)) return false
      const assigned = yield* db.findProviderUserRoles(session.userId)
      if (
        !(yield* auth.canRequestRole(
          new ProviderUserPrincipal(session.email, {
            roles: assigned,
            orgUnitId: owner.value.orgUnitPath,
          }),
          new RoleRef(switchedRole),
        ))
      )
        return false
    }
    return yield* auth.canLogin(
      new ProviderUserPrincipal(session.email, {
        roles: session.roles,
        orgUnitId: session.orgUnitPath,
      }),
      { uid: { type: "PF::Application", id: "frontend" } },
    )
  })
