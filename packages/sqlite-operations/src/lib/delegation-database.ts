import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  notInArray,
  or,
} from "drizzle-orm"
import { DateTime, Effect, Layer, Option } from "effect"
import { DelegationDatabase, mapQueryError, mapWriteError } from "@pf/auth-api"
import * as schema from "@pf/drizzle-sqlite"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"

export const SqliteDelegationDatabaseLive = Layer.effect(
  DelegationDatabase,
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle
    // A replacement event refers to the superseded generation. This durable
    // relation is unambiguous even when several replacements share a second.
    const superseded = db
      .select({ id: schema.delegationHistory.secretGenerationId })
      .from(schema.delegationHistory)
      .where(eq(schema.delegationHistory.delegationEvent, "replaced"))
    return DelegationDatabase.of({
      hasGeneration: (generationId) =>
        db
          .select({ id: schema.secretGeneration.id })
          .from(schema.secretGeneration)
          .where(eq(schema.secretGeneration.id, generationId))
          .limit(1)
          .pipe(
            Effect.map((rows) => rows.length > 0),
            mapQueryError("Failed to check Secret Generation"),
          ),
      findGeneration: (lookup) =>
        db
          .select({
            id: schema.delegation.id,
            name: schema.delegation.delegationName,
            generationId: schema.secretGeneration.id,
            parentGenerationId:
              schema.secretGeneration.parentSecretGenerationId,
            ownerId: schema.providerUser.id,
            userId: schema.providerUser.userId,
            createdAt: schema.secretGeneration.secretIssuedAt,
            expiresAt: schema.secretGeneration.secretExpiresAt,
            revokedAt: schema.delegation.secretRevokedAt,
            generationRevokedAt: schema.secretGeneration.secretRevokedAt,
            lastUsedAt: schema.secretGeneration.secretLastUsedAt,
          })
          .from(schema.secretGeneration)
          .innerJoin(
            schema.delegation,
            eq(schema.delegation.id, schema.secretGeneration.delegationId),
          )
          .innerJoin(
            schema.providerUser,
            eq(schema.providerUser.id, schema.delegation.ownerProviderUserId),
          )
          .innerJoin(
            schema.user,
            eq(schema.user.id, schema.providerUser.userId),
          )
          .where(
            and(
              "verifier" in lookup
                ? eq(schema.secretGeneration.secretVerifier, lookup.verifier)
                : eq(schema.secretGeneration.id, lookup.generationId),
              eq(schema.secretGeneration._deleted, false),
              notInArray(schema.secretGeneration.id, superseded),
              eq(schema.delegation._deleted, false),
              eq(schema.providerUser._deleted, false),
              eq(schema.user._deleted, false),
            ),
          )
          .pipe(
            Effect.map((rows) =>
              Option.fromNullable(rows[0]).pipe(
                Option.map((row) => ({
                  ...row,
                  expiresAt: DateTime.unsafeMake(
                    Math.round(DateTime.toEpochMillis(row.expiresAt) / 1000) *
                      1000,
                  ),
                })),
              ),
            ),
            mapQueryError("Failed to resolve Secret Generation"),
          ),
      recordUse: ({ generationId, usedAt }) =>
        db
          .update(schema.secretGeneration)
          .set({ secretLastUsedAt: usedAt })
          .where(
            and(
              eq(schema.secretGeneration.id, generationId),
              or(
                isNull(schema.secretGeneration.secretLastUsedAt),
                lte(
                  schema.secretGeneration.secretLastUsedAt,
                  DateTime.subtract(usedAt, { seconds: 30 }),
                ),
              ),
            ),
          )
          .pipe(Effect.asVoid, mapWriteError("Failed to record delegated use")),
      recordLogin: ({ delegationId, generationId, ownerId, loggedInAt }) =>
        db
          .insert(schema.delegationHistory)
          .values({
            delegationId,
            secretGenerationId: generationId,
            actorProviderUserId: ownerId,
            actorDelegationId: delegationId,
            actorSecretGenerationId: generationId,
            delegationEvent: "login",
            secretIssuedAt: loggedInAt,
          })
          .pipe(
            Effect.asVoid,
            mapWriteError("Failed to record delegated login"),
          ),
      isSecretLoginEnabled: () =>
        db
          .select({ config: schema.oauthProvider.providerConfig })
          .from(schema.oauthProvider)
          .where(eq(schema.oauthProvider._deleted, false))
          .pipe(
            Effect.map((rows) =>
              rows.some(
                ({ config }) =>
                  typeof config === "object" &&
                  config !== null &&
                  "delegatedAccess" in config &&
                  config["delegatedAccess"] === true,
              ),
            ),
            mapQueryError(
              "Failed to read secret-login presentation configuration",
            ),
          ),
      findOwnerId: (userId) =>
        db
          .select({ id: schema.providerUser.id })
          .from(schema.providerUser)
          .innerJoin(
            schema.user,
            eq(schema.user.id, schema.providerUser.userId),
          )
          .where(
            and(
              eq(schema.providerUser.userId, userId),
              eq(schema.providerUser._deleted, false),
              eq(schema.user._deleted, false),
            ),
          )
          .pipe(
            Effect.map((rows) => Option.fromNullable(rows[0]?.id)),
            mapQueryError("Failed to resolve Delegation owner"),
          ),
      list: (ownerId) =>
        db
          .select({
            id: schema.delegation.id,
            name: schema.delegation.delegationName,
            generationId: schema.secretGeneration.id,
            createdAt: schema.secretGeneration.secretIssuedAt,
            expiresAt: schema.secretGeneration.secretExpiresAt,
            revokedAt: schema.delegation.secretRevokedAt,
            lastUsedAt: schema.secretGeneration.secretLastUsedAt,
          })
          .from(schema.delegation)
          .innerJoin(
            schema.secretGeneration,
            eq(schema.secretGeneration.delegationId, schema.delegation.id),
          )
          .where(
            and(
              eq(schema.delegation.ownerProviderUserId, ownerId),
              eq(schema.delegation._deleted, false),
              eq(schema.secretGeneration._deleted, false),
              notInArray(schema.secretGeneration.id, superseded),
            ),
          )
          .orderBy(schema.secretGeneration.secretIssuedAt, schema.delegation.id)
          .pipe(
            // Issuance uses whole seconds; Julian-day decoding can truncate just
            // below that second. Restore the stored precision at this boundary.
            Effect.map((rows) =>
              rows.map((row) => ({
                ...row,
                createdAt: DateTime.unsafeMake(
                  Math.round(DateTime.toEpochMillis(row.createdAt) / 1000) *
                    1000,
                ),
                expiresAt: DateTime.unsafeMake(
                  Math.round(DateTime.toEpochMillis(row.expiresAt) / 1000) *
                    1000,
                ),
                revokedAt:
                  row.revokedAt === null
                    ? null
                    : DateTime.unsafeMake(
                        Math.round(
                          DateTime.toEpochMillis(row.revokedAt) / 1000,
                        ) * 1000,
                      ),
              })),
            ),
            mapQueryError("Failed to list Delegations"),
          ),
      releaseExpiredNames: (ownerId, now) =>
        db
          .update(schema.delegation)
          .set({ activeDelegationName: null })
          .where(
            and(
              eq(schema.delegation.ownerProviderUserId, ownerId),
              or(
                isNotNull(schema.delegation.secretRevokedAt),
                inArray(
                  schema.delegation.id,
                  db
                    .select({ id: schema.secretGeneration.delegationId })
                    .from(schema.secretGeneration)
                    .where(
                      and(
                        eq(schema.secretGeneration._deleted, false),
                        notInArray(schema.secretGeneration.id, superseded),
                        lte(schema.secretGeneration.secretExpiresAt, now),
                      ),
                    ),
                ),
              ),
            ),
          )
          .pipe(
            Effect.asVoid,
            mapWriteError("Failed to release expired Delegation names"),
          ),
      claimName: ({ id, ownerId, name }) =>
        db
          .insert(schema.delegation)
          .values({
            id,
            ownerProviderUserId: ownerId,
            delegationName: name,
            activeDelegationName: name,
          })
          .onConflictDoNothing()
          .returning({ id: schema.delegation.id })
          .pipe(
            Effect.map((rows) => rows.length === 1),
            mapWriteError("Failed to claim Delegation name"),
          ),
      updateName: ({ id, name, activeName }) =>
        db
          .update(schema.delegation)
          .set({ delegationName: name, activeDelegationName: activeName })
          .where(eq(schema.delegation.id, id))
          .pipe(Effect.asVoid, mapWriteError("Failed to rename Delegation")),
      revokeGeneration: ({ generationId, revokedAt }) =>
        db
          .update(schema.secretGeneration)
          .set({ secretRevokedAt: revokedAt })
          .where(
            and(
              eq(schema.secretGeneration.id, generationId),
              isNull(schema.secretGeneration.secretRevokedAt),
            ),
          )
          .pipe(
            Effect.asVoid,
            mapWriteError("Failed to revoke Secret Generation"),
          ),
      revoke: ({ id, revokedAt }) =>
        db
          .update(schema.delegation)
          .set({ secretRevokedAt: revokedAt, activeDelegationName: null })
          .where(
            and(
              eq(schema.delegation.id, id),
              isNull(schema.delegation.secretRevokedAt),
            ),
          )
          .pipe(Effect.asVoid, mapWriteError("Failed to revoke Delegation")),
      recordChange: (input) =>
        db
          .insert(schema.delegationHistory)
          .values({
            delegationId: input.delegationId,
            secretGenerationId: input.generationId,
            actorProviderUserId: input.actorId,
            actorDelegationId: input.actorDelegation?.id,
            actorSecretGenerationId: input.actorDelegation?.generationId,
            delegationEvent: input.event,
            secretIssuedAt: input.occurredAt,
            ...(input.event === "renamed"
              ? {
                  oldDelegationName: input.oldName,
                  newDelegationName: input.newName,
                }
              : {}),
          })
          .pipe(
            Effect.asVoid,
            mapWriteError("Failed to record Delegation change"),
          ),
      insertGeneration: ({
        id,
        delegationId,
        parentGenerationId,
        verifier,
        issuedAt,
        expiresAt,
      }) =>
        db
          .insert(schema.secretGeneration)
          .values({
            id,
            delegationId,
            parentSecretGenerationId: parentGenerationId ?? null,
            secretVerifier: verifier,
            secretIssuedAt: issuedAt,
            secretExpiresAt: expiresAt,
          })
          .pipe(
            Effect.asVoid,
            mapWriteError("Failed to store Secret Generation"),
          ),
      recordIssuance: ({
        delegationId,
        generationId,
        actorId,
        actorDelegation,
        issuedAt,
      }) =>
        db
          .insert(schema.delegationHistory)
          .values({
            delegationId,
            secretGenerationId: generationId,
            actorProviderUserId: actorId,
            actorDelegationId: actorDelegation?.id,
            actorSecretGenerationId: actorDelegation?.generationId,
            delegationEvent: "issued",
            secretIssuedAt: issuedAt,
          })
          .pipe(
            Effect.asVoid,
            mapWriteError("Failed to record Delegation issuance"),
          ),
    })
  }),
)
