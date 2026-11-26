import { createHash } from "node:crypto"
import { Context, Data, DateTime, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import type { ProviderUserSession } from "@pf/auth-session"
import { DelegationDatabase } from "./delegation-database.js"
import { DelegationIdentityFacts } from "./delegation-identity-facts.js"

export class InvalidDelegationSession extends Data.TaggedError(
  "InvalidDelegationSession",
)<Record<never, never>> {}

export type DelegatedSession = ProviderUserSession & {
  readonly delegation: NonNullable<ProviderUserSession["delegation"]>
}

export class DelegationCredentialService extends Context.Service<
  DelegationCredentialService,
  {
    /** Call only after signature/issuer/audience verification. Never cache the result. */
    readonly check: (
      session: ProviderUserSession,
    ) => Effect.Effect<DelegatedSession, InvalidDelegationSession>
    readonly exchange: (
      secret: string,
    ) => Effect.Effect<DelegatedSession, InvalidDelegationSession>
  }
>()("@pf/delegation/DelegationCredentialService") {}

export interface DelegationOwnerFacts {
  readonly id: string
  readonly owner: string
  readonly name: string
  readonly roles: readonly string[]
  readonly orgUnitId: string
}

/** Captures services only. Call after signature/issuer/audience verification; never cache results. */
export const makeDelegationCredentialChecker =
  ({
    db,
    authDb,
    acceptOwner,
  }: {
    readonly db: Context.Service.Shape<typeof DelegationDatabase>
    readonly authDb: Context.Service.Shape<typeof DelegationIdentityFacts>
    readonly acceptOwner: (
      facts: DelegationOwnerFacts,
      now: DateTime.Utc,
    ) => Effect.Effect<void, InvalidDelegationSession>
  }): Context.Service.Shape<typeof DelegationCredentialService>["check"] =>
  (
    session: ProviderUserSession,
  ): Effect.Effect<DelegatedSession, InvalidDelegationSession> =>
    Effect.gen(function* () {
      const now = yield* DateTime.now
      const identity = session.delegation
      if (!identity || session.humanAuthentication !== undefined)
        return yield* new InvalidDelegationSession()
      const found = yield* db.findGeneration({
        generationId: identity.generationId,
      })
      if (Option.isNone(found)) return yield* new InvalidDelegationSession()
      const generation = found.value
      const expiresAt = DateTime.toEpochMillis(generation.expiresAt)
      if (
        generation.id !== identity.id ||
        generation.userId !== session.userId ||
        generation.revokedAt !== null ||
        generation.generationRevokedAt !== null ||
        identity.expiresAt !== expiresAt ||
        DateTime.toEpochMillis(now) >= expiresAt
      )
        return yield* new InvalidDelegationSession()
      const owner = yield* authDb.findProviderUserByUserId(generation.userId)
      if (Option.isNone(owner) || owner.value.email !== session.email)
        return yield* new InvalidDelegationSession()
      const assignedRoles = yield* authDb.findProviderUserRoles(
        generation.userId,
      )
      const roles =
        session.delegationRoleSelection === undefined
          ? assignedRoles
          : assignedRoles.filter((role) =>
              session.delegationRoleSelection?.includes(role),
            )
      yield* acceptOwner(
        {
          id: generation.id,
          owner: owner.value.email,
          name: generation.name,
          roles,
          orgUnitId: owner.value.orgUnitPath,
        },
        now,
      )
      // Credentials identify only the leaf. Immutable storage supplies every
      // ancestor, with each owner's current authority checked independently.
      const generations = new Set([generation.generationId])
      const delegations = new Set([generation.id])
      let child = generation
      while (child.parentGenerationId !== null) {
        if (generations.has(child.parentGenerationId))
          return yield* new InvalidDelegationSession()
        const parent = yield* db.findGeneration({
          generationId: child.parentGenerationId,
        })
        if (Option.isNone(parent)) return yield* new InvalidDelegationSession()
        const ancestor = parent.value
        const ancestorExpiresAt = DateTime.toEpochMillis(ancestor.expiresAt)
        if (
          delegations.has(ancestor.id) ||
          ancestor.revokedAt !== null ||
          ancestor.generationRevokedAt !== null ||
          DateTime.toEpochMillis(now) >= ancestorExpiresAt ||
          DateTime.toEpochMillis(child.expiresAt) > ancestorExpiresAt
        )
          return yield* new InvalidDelegationSession()
        generations.add(ancestor.generationId)
        delegations.add(ancestor.id)
        const ancestorOwner = yield* authDb.findProviderUserByUserId(
          ancestor.userId,
        )
        if (Option.isNone(ancestorOwner))
          return yield* new InvalidDelegationSession()
        const ancestorRoles = yield* authDb.findProviderUserRoles(
          ancestor.userId,
        )
        yield* acceptOwner(
          {
            id: ancestor.id,
            owner: ancestorOwner.value.email,
            name: ancestor.name,
            roles: ancestorRoles,
            orgUnitId: ancestorOwner.value.orgUnitPath,
          },
          now,
        )
        child = ancestor
      }
      yield* db.recordUse({
        generationId: generation.generationId,
        usedAt: now,
      })
      return {
        userId: generation.userId,
        email: owner.value.email,
        orgUnitId: owner.value.orgUnitId,
        orgUnitPath: owner.value.orgUnitPath,
        roles,
        ...(session.delegationRoleSelection === undefined
          ? {}
          : { delegationRoleSelection: roles }),
        delegation: {
          id: generation.id,
          generationId: generation.generationId,
          name: generation.name,
          expiresAt,
        },
      }
    }).pipe(Effect.mapError(() => new InvalidDelegationSession()))

/** Shared exchange transaction and audit semantics, independent of policy. */
export const makeDelegationExchange = (
  check: Context.Service.Shape<typeof DelegationCredentialService>["check"],
) =>
  Effect.gen(function* () {
    const db = yield* DelegationDatabase
    const authDb = yield* DelegationIdentityFacts
    const sql = yield* SqlClient.SqlClient
    return DelegationCredentialService.of({
      check,
      exchange: (secret) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              if (!/^pfds_[A-Za-z0-9_-]{43}$/.test(secret))
                return yield* new InvalidDelegationSession()
              const verifier = createHash("sha256")
                .update(secret)
                .digest("base64url")
              const found = yield* db.findGeneration({ verifier })
              if (Option.isNone(found))
                return yield* new InvalidDelegationSession()
              const generation = found.value
              const owner = yield* authDb.findProviderUserByUserId(
                generation.userId,
              )
              if (Option.isNone(owner))
                return yield* new InvalidDelegationSession()
              const session = yield* check({
                userId: generation.userId,
                email: owner.value.email,
                orgUnitId: owner.value.orgUnitId,
                orgUnitPath: owner.value.orgUnitPath,
                roles: [],
                delegation: {
                  id: generation.id,
                  generationId: generation.generationId,
                  name: generation.name,
                  expiresAt: DateTime.toEpochMillis(generation.expiresAt),
                },
              })
              yield* db.recordLogin({
                delegationId: generation.id,
                generationId: generation.generationId,
                ownerId: generation.ownerId,
                loggedInAt: yield* DateTime.now,
              })
              return session
            }),
          )
          .pipe(Effect.mapError(() => new InvalidDelegationSession())),
    })
  })

/** Identity and credential lifecycle only; never application admission. */
export const DelegationCredentialServiceLive = Layer.effect(
  DelegationCredentialService,
  Effect.gen(function* () {
    const db = yield* DelegationDatabase
    const authDb = yield* DelegationIdentityFacts
    return yield* makeDelegationExchange(
      makeDelegationCredentialChecker({
        db,
        authDb,
        // Issuance validates credentials only; protected boundaries supply Cedar admission.
        acceptOwner: () => Effect.void,
      }),
    )
  }),
)
