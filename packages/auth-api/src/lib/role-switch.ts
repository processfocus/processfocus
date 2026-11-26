import { createHash } from "node:crypto"
import { Context, Data, DateTime, Effect, Option, Schema } from "effect"
import {
  ActivePolicyRevision,
  PolicyRevisionUnavailable,
} from "@pf/auth-policy"
import type { ProviderUserSession } from "@pf/auth-session"
import { AuthenticationDatabase } from "./authentication-database"
import { SSO_REVALIDATION_INTERVAL_MS } from "./sso-policy"

export class InvalidRolePreparation extends Data.TaggedError(
  "InvalidRolePreparation",
)<{
  readonly reason:
    | "authorization-unavailable"
    | "missing-session"
    | "missing-expired-or-consumed"
    | "malformed-receipt"
    | "expired"
    | "invalid-deadline"
    | "version-mismatch"
    | "owner-mismatch"
    | "unknown-role"
}> {
  override get message(): string {
    return `Invalid role preparation: ${this.reason}`
  }
}

export const ROLE_PREPARATION_LIFETIME_MS = 10 * 60 * 1000
const preparationSchema = Schema.Struct({
  version: Schema.String,
  expiresAt: Schema.Number,
})

const preparationKey = (session: ProviderUserSession, role: string) =>
  `role-switch:${JSON.stringify([session.userId, session.sessionId, role])}`

/** Issuer callbacks retain only their declared authority dependencies. */
export const captureRoleAuthority = Effect.gen(function* () {
  const db = yield* AuthenticationDatabase
  const revision = yield* Effect.serviceOption(ActivePolicyRevision)
  return Context.make(AuthenticationDatabase, db).pipe(
    Context.add(
      ActivePolicyRevision,
      Option.getOrElse(revision, () => ({
        current: Effect.fail(new PolicyRevisionUnavailable()),
      })),
    ),
  )
})

/** Compare policy artifacts, not policy decisions, at the issuer. */
export const providerUserAuthorityVersion = (userId: string) =>
  Effect.gen(function* () {
    const db = yield* AuthenticationDatabase
    const revision = yield* ActivePolicyRevision
    const policy = yield* revision.current.pipe(
      Effect.mapError(
        () =>
          new InvalidRolePreparation({ reason: "authorization-unavailable" }),
      ),
    )
    if (!policy)
      return yield* new InvalidRolePreparation({
        reason: "authorization-unavailable",
      })
    const assignments = yield* db.findProviderUserAuthorityVersion(userId)
    return createHash("sha256")
      .update(JSON.stringify([policy, assignments]))
      .digest("hex")
  })

/** GraphQL calls this only after the live account-principal Cedar decision. */
export const prepareRoleSwitch = (
  session: ProviderUserSession,
  role: string,
  version: string,
) =>
  Effect.gen(function* () {
    if (!session.sessionId)
      return yield* new InvalidRolePreparation({ reason: "missing-session" })
    const db = yield* AuthenticationDatabase
    const now = yield* DateTime.now
    const expiresAt = Math.min(
      DateTime.toEpochMillis(now) + ROLE_PREPARATION_LIFETIME_MS,
      session.workload?.expiresAt ?? Infinity,
      session.sso?.expiresAt ?? Infinity,
    )
    if (version !== (yield* providerUserAuthorityVersion(session.userId)))
      return yield* new InvalidRolePreparation({ reason: "version-mismatch" })
    yield* db.prepareRoleSwitch({
      key: preparationKey(session, role),
      value: { version, expiresAt },
      expiresAt: DateTime.makeUnsafe(expiresAt),
    })
  }).pipe(
    Effect.tapErrorTag("InvalidRolePreparation", ({ reason }) =>
      Effect.logWarning("Role switch preparation denied", {
        userId: session.userId,
        orgUnitId: session.orgUnitId,
        orgUnitPath: session.orgUnitPath,
        role,
        reason,
      }),
    ),
  )

/** Legacy unbound rows are deliberately never consulted. DELETE RETURNING owns single-use. */
export const redeemRoleSwitch = (session: ProviderUserSession, role: string) =>
  Effect.gen(function* () {
    if (!session.sessionId)
      return yield* new InvalidRolePreparation({ reason: "missing-session" })
    const db = yield* AuthenticationDatabase
    const value = yield* db.consumeRoleSwitch(preparationKey(session, role))
    // Atomic consumption cannot distinguish absence, expiry, replay or a different binding.
    if (value === undefined)
      return yield* new InvalidRolePreparation({
        reason: "missing-expired-or-consumed",
      })
    const receipt = yield* Schema.decodeUnknownEffect(preparationSchema)(
      value,
    ).pipe(
      Effect.mapError(
        () => new InvalidRolePreparation({ reason: "malformed-receipt" }),
      ),
    )
    const now = DateTime.toEpochMillis(yield* DateTime.now)
    if (now >= receipt.expiresAt)
      return yield* new InvalidRolePreparation({ reason: "expired" })
    if (receipt.expiresAt > now + ROLE_PREPARATION_LIFETIME_MS)
      return yield* new InvalidRolePreparation({ reason: "invalid-deadline" })
    if (
      receipt.version !== (yield* providerUserAuthorityVersion(session.userId))
    )
      return yield* new InvalidRolePreparation({ reason: "version-mismatch" })
    const owner = yield* db.findProviderUserByUserId(session.userId)
    if (Option.isNone(owner) || owner.value.email !== session.email)
      return yield* new InvalidRolePreparation({ reason: "owner-mismatch" })
    const assigned = yield* db.findProviderUserRoles(session.userId)
    const roles = yield* db.validateRolePathsWithOrgUnit([role])
    const target = roles[0]
    if (!target)
      return yield* new InvalidRolePreparation({ reason: "unknown-role" })
    return {
      ...session,
      roles: [role],
      switchedRole: role,
      orgUnitId: assigned.includes(role)
        ? owner.value.orgUnitId
        : target.orgUnitId,
      orgUnitPath: assigned.includes(role)
        ? owner.value.orgUnitPath
        : target.orgUnitPath,
      temporaryRoleAuthority: assigned.includes(role)
        ? undefined
        : { role, ...receipt },
    }
  }).pipe(
    Effect.tapErrorTag("InvalidRolePreparation", ({ reason }) =>
      Effect.logWarning("Role switch redemption denied", {
        userId: session.userId,
        orgUnitId: session.orgUnitId,
        orgUnitPath: session.orgUnitPath,
        role,
        reason,
      }),
    ),
  )

/** Selection is checked, never widened. Temporary authority is separate from its spent receipt. */
export const checkProviderUserAssignments = (session: ProviderUserSession) =>
  Effect.gen(function* () {
    if (
      session.workload ||
      session.authenticationMethod === "client_credentials"
    )
      return false
    const db = yield* AuthenticationDatabase
    const owner = yield* db.findProviderUserByUserId(session.userId)
    if (Option.isNone(owner) || owner.value.email !== session.email)
      return false
    if (session.sso) {
      const now = DateTime.toEpochMillis(yield* DateTime.now)
      if (
        session.sso.provider !== owner.value.provider ||
        session.sso.subject !== owner.value.sub ||
        session.sso.verifiedAt > now ||
        session.sso.expiresAt >
          session.sso.verifiedAt + SSO_REVALIDATION_INTERVAL_MS ||
        now >= session.sso.expiresAt
      )
        return false
    } else if (
      !session.delegation &&
      !session.authenticationMethod &&
      !session.humanAuthentication &&
      owner.value.provider !== "passkey" &&
      owner.value.provider !== "dummy"
    ) {
      // Legacy OAuth and ambiguous impersonation credentials must authenticate anew.
      return false
    }
    const assigned = yield* db.findProviderUserRoles(session.userId)
    const temporary = session.temporaryRoleAuthority
    if (
      temporary &&
      (!session.sessionId ||
        DateTime.toEpochMillis(yield* DateTime.now) >= temporary.expiresAt ||
        temporary.version !==
          (yield* providerUserAuthorityVersion(session.userId)))
    )
      return false
    if (
      session.roles.some(
        (role) => !assigned.includes(role) && temporary?.role !== role,
      )
    )
      return false
    const first = session.roles[0]
    const context =
      first && !assigned.includes(first)
        ? (yield* db.validateRolePathsWithOrgUnit([first]))[0]
        : owner.value
    return (
      context !== undefined &&
      context.orgUnitId === session.orgUnitId &&
      context.orgUnitPath === session.orgUnitPath
    )
  })
