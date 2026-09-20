import { createHash, randomBytes, randomUUID } from "node:crypto"
import { SqlClient } from "@effect/sql"
import { DateTime, Effect, Option, Schema } from "effect"
import { StorageService } from "@pf/openauth"
import { AuthenticationDatabase } from "./authentication-database.js"
import { getPasskeyUserHandle } from "./passkey-user-handle.js"

const LINK_TTL_SECONDS = 24 * 60 * 60
const SESSION_TTL_SECONDS = 10 * 60
const RecoveryGrant = Schema.Struct({
  recoveryId: Schema.String,
  userId: Schema.String,
  userHandle: Schema.String,
  email: Schema.String,
  invitationId: Schema.String,
  actor: Schema.String,
})
export type PasskeyRecoveryGrant = typeof RecoveryGrant.Type

export const isPasskeyRecoveryLink = (token: string): boolean =>
  /^pfr_[A-Za-z0-9_-]{43}$/.test(token)
export const isPasskeyRecoverySession = (token: string): boolean =>
  /^pfrs_[A-Za-z0-9_-]{43}$/.test(token)
export const hashPasskeyRecoveryBearer = (token: string): string =>
  createHash("sha256").update(token).digest("base64url")

const currentKey = (userId: string): string[] => [
  "passkey-recovery-current",
  userId,
]
const sessionKey = (bearer: string): string[] => [
  "passkey-recovery-session",
  hashPasskeyRecoveryBearer(bearer),
]

const readGrant = (key: string[]) =>
  Effect.gen(function* () {
    const storage = yield* StorageService
    return Schema.decodeUnknownOption(RecoveryGrant)(
      yield* storage.get<unknown>(key),
    )
  })

const validateGrant = (grant: PasskeyRecoveryGrant) =>
  Effect.gen(function* () {
    const db = yield* AuthenticationDatabase
    const storage = yield* StorageService
    if (
      (yield* storage.get<unknown>(currentKey(grant.userId))) !==
      grant.recoveryId
    )
      return false
    const provider = yield* db.findOAuthProviderByName("passkey")
    if (Option.isNone(provider)) return false
    const user = yield* db.findProviderUserByUserId(grant.userId)
    if (Option.isNone(user) || user.value.email !== grant.email) return false
    const handle = getPasskeyUserHandle({
      ...user.value,
      userId: user.value.id,
    })
    if (handle !== grant.userHandle) return false
    const invitation = yield* db.findRecoveryInvitation(
      grant.userId,
      grant.email,
    )
    if (Option.isNone(invitation) || invitation.value !== grant.invitationId)
      return false
    if (yield* db.hasPendingInvitation(grant.email)) return false
    return (yield* db.findProviderUserRoles(grant.userId)).length > 0
  })

/** Caller has explicitly authorized account recovery, independently of invitation administration. */
export const issuePasskeyRecoveryLink = (input: {
  readonly email: string
  readonly actor: string
  readonly frontendOrigin: string
}) =>
  Effect.gen(function* () {
    const db = yield* AuthenticationDatabase
    const storage = yield* StorageService
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const email = input.email.trim().toLowerCase()
        const user = yield* db.findProviderUserByEmail(email)
        const denied = {
          ok: false as const,
          error:
            "Cannot recover this account. An active account with current roles and a closed, non-deleted invitation is required.",
        }
        if (Option.isNone(user)) return denied
        const invitation = yield* db.findRecoveryInvitation(
          user.value.id,
          email,
        )
        if (
          Option.isNone(invitation) ||
          (yield* db.hasPendingInvitation(email))
        )
          return denied
        if (Option.isNone(yield* db.findOAuthProviderByName("passkey")))
          return denied
        if ((yield* db.findProviderUserRoles(user.value.id)).length === 0)
          return denied
        const now = yield* DateTime.now
        const grant: PasskeyRecoveryGrant = {
          recoveryId: randomUUID(),
          userId: user.value.id,
          email,
          userHandle: getPasskeyUserHandle({
            ...user.value,
            userId: user.value.id,
          }),
          invitationId: invitation.value,
          actor: input.actor,
        }
        const token = `pfr_${randomBytes(32).toString("base64url")}`
        yield* storage.set(
          currentKey(grant.userId),
          grant.recoveryId,
          LINK_TTL_SECONDS,
        )
        yield* storage.set(
          ["passkey-recovery-link", hashPasskeyRecoveryBearer(token)],
          grant,
          LINK_TTL_SECONDS,
        )
        // Durable audit metadata contains neither the link nor a usable token hash.
        yield* storage.set(
          ["passkey-recovery-audit", grant.recoveryId, "issued"],
          {
            ...grant,
            at: DateTime.formatIso(now),
          },
        )
        return {
          ok: true as const,
          email,
          registrationLinkUrl: `${input.frontendOrigin.replace(/\/$/, "")}/register/passkey#token=${token}`,
          expiresAt: DateTime.toDateUtc(
            DateTime.add(now, { seconds: LINK_TTL_SECONDS }),
          ),
        }
      }),
    )
  })

export const exchangePasskeyRecoveryLink = (token: string) =>
  Effect.gen(function* () {
    const storage = yield* StorageService
    const grant = yield* readGrant([
      "passkey-recovery-link",
      hashPasskeyRecoveryBearer(token),
    ])
    if (Option.isNone(grant) || !(yield* validateGrant(grant.value)))
      return Option.none()
    const sessionBearer = `pfrs_${randomBytes(32).toString("base64url")}`
    const now = yield* DateTime.now
    yield* storage.set(
      sessionKey(sessionBearer),
      grant.value,
      SESSION_TTL_SECONDS,
    )
    return Option.some({
      email: grant.value.email,
      sessionBearer,
      expiresAt: DateTime.add(now, { seconds: SESSION_TTL_SECONDS }),
    })
  })

export const resolvePasskeyRecoverySession = (bearer: string) =>
  Effect.gen(function* () {
    const grant = yield* readGrant(sessionKey(bearer))
    if (Option.isNone(grant) || !(yield* validateGrant(grant.value)))
      return Option.none<PasskeyRecoveryGrant>()
    return grant
  })

/** Must run in the same SQL transaction as credential insertion. */
export const consumePasskeyRecovery = (grant: PasskeyRecoveryGrant) =>
  Effect.gen(function* () {
    const storage = yield* StorageService
    if (!(yield* validateGrant(grant))) return false
    const current = yield* storage.take<unknown>(currentKey(grant.userId))
    if (current !== grant.recoveryId) return false
    yield* storage.set(
      ["passkey-recovery-audit", grant.recoveryId, "consumed"],
      {
        userId: grant.userId,
        actor: grant.actor,
        at: DateTime.formatIso(yield* DateTime.now),
      },
    )
    return true
  })
