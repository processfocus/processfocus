import { createHash, randomBytes } from "node:crypto"
import {
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm"
import { Data, DateTime, Effect, Layer, Option, Stream } from "effect"
import {
  AuthenticationDatabase,
  type CreatePasskeyCredentialInput,
  type CreateProviderUserInput,
  type InvitationRegistrationSessionContext,
  type OAuthClientRecord,
  type OAuthStorageValue,
  type OrgUnitRecord,
  type PasskeyCredentialRecord,
  type PasskeyManagementCredential,
  type ProviderUserRecord,
  REGISTRATION_SESSION_TTL_MINUTES,
  type RegistrationSessionExchangeResult,
  type RemovePasskeyCredentialResult,
  mapQueryError,
  mapWriteError,
} from "@pf/auth-api"
import type { OAuthProviderConfig } from "@pf/auth-config"
import * as schema from "@pf/drizzle-postgres"
import {
  InvitationLifecycleStatus,
  returnedRow,
} from "@pf/graphql-db-operations"
import { StorageError, StorageService } from "@pf/openauth"
import { TypedPostgresDrizzle } from "@pf/service-drizzle-postgres"

const REGISTRATION_SESSION_TOKEN_BYTES = 32

const hashBearerToken = (rawToken: string): string =>
  createHash("sha256")
    .update(Buffer.from(rawToken, "base64url"))
    .digest("base64url")

const generateRegistrationSessionBearer = (): {
  rawBearer: string
  tokenHash: string
} => {
  const rawBytes = randomBytes(REGISTRATION_SESSION_TOKEN_BYTES)
  return {
    rawBearer: rawBytes.toString("base64url"),
    tokenHash: createHash("sha256").update(rawBytes).digest("base64url"),
  }
}

class ProviderUserNotFoundError extends Data.TaggedError(
  "ProviderUserNotFoundError",
)<{
  readonly userId: string
}> {}

class OrgUnitNotFoundError extends Data.TaggedError("OrgUnitNotFoundError")<{
  readonly orgUnitId: string
}> {}

const SEPARATOR = String.fromCharCode(0x1f)
const PREFIX_UPPER_BOUND = String.fromCharCode(0xffff)

const joinKey = (key: string[]): string => key.join(SEPARATOR)

const prefixUpperBound = (prefix: string): string =>
  `${prefix}${PREFIX_UPPER_BOUND}`

const splitKey = (key: string): string[] => key.split(SEPARATOR)

const extractStorageType = (key: string[]): string => {
  return key[0] ?? "unknown"
}

const toOrgUnitRecord = (
  orgUnit: typeof schema.orgUnit.$inferSelect,
): OrgUnitRecord => ({
  id: orgUnit.id,
  name: orgUnit.name,
  orgUnitLevel: orgUnit.orgUnitLevel,
  path: orgUnit.path,
  parentOrgUnitId: orgUnit.parentOrgUnitId,
})

/**
 * Convert database providerUser/user/orgUnit records to ProviderUserRecord.
 * Note: `id` is intentionally set to `userId` (not `providerUser.id`) because
 * this is the ID used in JWT sessions and for user identification.
 */
const toProviderUserRecord = (data: {
  providerUser: typeof schema.providerUser.$inferSelect
  user: typeof schema.user.$inferSelect
  orgUnit: { path: string }
}): ProviderUserRecord => ({
  id: data.providerUser.userId,
  email: data.providerUser.email,
  locale: data.providerUser.locale,
  picture: data.providerUser.picture,
  provider: data.user.provider,
  sub: data.user.sub,
  orgUnitId: data.providerUser.orgUnitId,
  orgUnitPath: data.orgUnit.path,
})

export const PostgresAuthenticationDatabaseLive = Layer.effect(
  AuthenticationDatabase,
  Effect.gen(function* () {
    const db = yield* TypedPostgresDrizzle

    return {
      findRecoveryInvitation: (userId: string, email: string) =>
        Effect.gen(function* () {
          const rows = yield* db
            .select({ id: schema.invitation.id })
            .from(schema.invitation)
            .innerJoin(
              schema.providerUser,
              eq(
                schema.invitation.acceptedByProviderUserId,
                schema.providerUser.id,
              ),
            )
            .where(
              and(
                eq(schema.providerUser.userId, userId),
                eq(schema.providerUser.email, email),
                eq(schema.providerUser._deleted, false),
                eq(schema.invitation.email, email),
                inArray(schema.invitation.invitationStatus, [
                  InvitationLifecycleStatus.Accepted,
                  InvitationLifecycleStatus.LegacyClosed,
                ]),
                eq(schema.invitation._deleted, false),
              ),
            )
            .limit(1)
          return Option.fromNullable(rows[0]?.id)
        }).pipe(mapQueryError("Failed to find recovery invitation")),
      findRootOrgUnit: () =>
        Effect.gen(function* () {
          const results = yield* db
            .select()
            .from(schema.orgUnit)
            .where(
              and(
                isNull(schema.orgUnit.parentOrgUnitId),
                eq(schema.orgUnit._deleted, false),
              ),
            )
            .limit(1)

          const orgUnit = results[0]
          if (!orgUnit) {
            return Option.none<OrgUnitRecord>()
          }

          return Option.some(toOrgUnitRecord(orgUnit))
        }).pipe(mapQueryError("Failed to find root organization unit")),

      findProviderUserByProviderSub: (provider: string, sub: string) =>
        Effect.gen(function* () {
          const results = yield* db
            .select()
            .from(schema.providerUser)
            .innerJoin(
              schema.user,
              eq(schema.providerUser.userId, schema.user.id),
            )
            .innerJoin(
              schema.orgUnit,
              eq(schema.providerUser.orgUnitId, schema.orgUnit.id),
            )
            .where(
              and(
                eq(schema.user.provider, provider),
                eq(schema.user.sub, sub),
                eq(schema.providerUser._deleted, false),
                eq(schema.user._deleted, false),
                eq(schema.orgUnit._deleted, false),
              ),
            )
            .limit(1)

          const row = results[0]
          if (!row) {
            return Option.none<ProviderUserRecord>()
          }

          return Option.some(
            toProviderUserRecord({
              providerUser: row.pf_provider_user,
              user: row.pf_user,
              orgUnit: row.pf_org_unit,
            }),
          )
        }).pipe(
          mapQueryError("Failed to find provider user by provider subject"),
        ),

      findProviderUserByEmail: (email: string) =>
        Effect.gen(function* () {
          const results = yield* db
            .select()
            .from(schema.providerUser)
            .innerJoin(
              schema.user,
              eq(schema.providerUser.userId, schema.user.id),
            )
            .innerJoin(
              schema.orgUnit,
              eq(schema.providerUser.orgUnitId, schema.orgUnit.id),
            )
            .where(
              and(
                sql`lower(${schema.providerUser.email}) = ${email.toLowerCase()}`,
                eq(schema.providerUser._deleted, false),
                eq(schema.user._deleted, false),
                eq(schema.orgUnit._deleted, false),
              ),
            )
            .limit(1)

          const row = results[0]
          if (!row) {
            return Option.none<ProviderUserRecord>()
          }

          return Option.some(
            toProviderUserRecord({
              providerUser: row.pf_provider_user,
              user: row.pf_user,
              orgUnit: row.pf_org_unit,
            }),
          )
        }).pipe(mapQueryError("Failed to find provider user by email")),

      findProviderUserById: (id: string) =>
        Effect.gen(function* () {
          const results = yield* db
            .select()
            .from(schema.providerUser)
            .innerJoin(
              schema.user,
              eq(schema.providerUser.userId, schema.user.id),
            )
            .innerJoin(
              schema.orgUnit,
              eq(schema.providerUser.orgUnitId, schema.orgUnit.id),
            )
            .where(
              and(
                eq(schema.providerUser.id, id),
                eq(schema.providerUser._deleted, false),
                eq(schema.user._deleted, false),
                eq(schema.orgUnit._deleted, false),
              ),
            )
            .limit(1)

          const row = results[0]
          if (!row) {
            return Option.none<ProviderUserRecord>()
          }

          return Option.some(
            toProviderUserRecord({
              providerUser: row.pf_provider_user,
              user: row.pf_user,
              orgUnit: row.pf_org_unit,
            }),
          )
        }).pipe(mapQueryError("Failed to find provider user by id")),

      findProviderUserByUserId: (userId: string) =>
        Effect.gen(function* () {
          const results = yield* db
            .select()
            .from(schema.providerUser)
            .innerJoin(
              schema.user,
              eq(schema.providerUser.userId, schema.user.id),
            )
            .innerJoin(
              schema.orgUnit,
              eq(schema.providerUser.orgUnitId, schema.orgUnit.id),
            )
            .where(
              and(
                eq(schema.providerUser.userId, userId),
                eq(schema.providerUser._deleted, false),
                eq(schema.user._deleted, false),
                eq(schema.orgUnit._deleted, false),
              ),
            )
            .limit(1)

          const row = results[0]
          if (!row) {
            return Option.none<ProviderUserRecord>()
          }

          return Option.some(
            toProviderUserRecord({
              providerUser: row.pf_provider_user,
              user: row.pf_user,
              orgUnit: row.pf_org_unit,
            }),
          )
        }).pipe(mapQueryError("Failed to find provider user by user id")),

      createProviderUser: (input: CreateProviderUserInput) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now

          // First, create the user record
          const userResult = yield* db
            .insert(schema.user)
            .values({
              provider: input.provider,
              sub: input.sub,
              lastLoggedIn: now,
            })
            .returning()

          const user = yield* returnedRow(userResult)

          // Then, create the provider user record with the generated userId
          const providerUserResult = yield* db
            .insert(schema.providerUser)
            .values({
              userId: user.id,
              email: input.email,
              name: input.name,
              firstName: input.firstName,
              lastName: input.lastName,
              picture: input.picture,
              locale: input.locale,
              orgUnitId: input.orgUnitId,
            })
            .returning()

          const providerUser = yield* returnedRow(providerUserResult)

          // Fetch the org unit path
          const orgUnitResult = yield* db
            .select({ path: schema.orgUnit.path })
            .from(schema.orgUnit)
            .where(eq(schema.orgUnit.id, input.orgUnitId))
            .limit(1)

          const orgUnit = orgUnitResult[0]
          if (!orgUnit) {
            // FK constraint violation - database integrity issue.
            // Typed failure so mapWriteError maps it to DatabaseWriteError
            // (matches SQLite AuthenticationDatabase createProviderUser).
            return yield* new OrgUnitNotFoundError({
              orgUnitId: input.orgUnitId,
            })
          }

          return toProviderUserRecord({ providerUser, user, orgUnit })
        }).pipe(mapWriteError("Failed to create provider user")),

      findPasskeyCredentialById: (credentialId: string) =>
        Effect.gen(function* () {
          const rows = yield* db
            .select({
              userId: schema.passkeyCredential.userId,
              email: schema.providerUser.email,
              sub: schema.user.sub,
              provider: schema.user.provider,
              credentialId: schema.passkeyCredential.passkeyCredentialId,
              publicKey: schema.passkeyCredential.passkeyPublicKey,
              counter: schema.passkeyCredential.signatureCounter,
              transports: schema.passkeyCredential.passkeyTransports,
            })
            .from(schema.passkeyCredential)
            .innerJoin(
              schema.user,
              eq(schema.passkeyCredential.userId, schema.user.id),
            )
            .innerJoin(
              schema.providerUser,
              eq(schema.providerUser.userId, schema.user.id),
            )
            .where(
              and(
                eq(schema.passkeyCredential.passkeyCredentialId, credentialId),
                eq(schema.passkeyCredential._deleted, false),
                eq(schema.user._deleted, false),
                eq(schema.providerUser._deleted, false),
              ),
            )
            .limit(1)

          const row = rows[0]
          if (!row) return Option.none<PasskeyCredentialRecord>()
          const transports = Array.isArray(row.transports)
            ? row.transports.filter(
                (transport): transport is string =>
                  typeof transport === "string",
              )
            : undefined
          return Option.some({
            userId: row.userId,
            email: row.email,
            provider: row.provider,
            sub: row.sub,
            credentialId: row.credentialId,
            publicKey: row.publicKey,
            counter: Number(row.counter),
            ...(transports && { transports }),
          })
        }).pipe(mapQueryError("Failed to find passkey credential")),

      createPasskeyCredential: (input: CreatePasskeyCredentialInput) =>
        db
          .insert(schema.passkeyCredential)
          .values({
            userId: input.userId,
            passkeyCredentialId: input.credentialId,
            passkeyPublicKey: input.publicKey,
            signatureCounter: String(input.counter),
            ...(input.transports && {
              passkeyTransports: [...input.transports],
            }),
            ...(input.name !== undefined && { passkeyName: input.name }),
          })
          .pipe(
            mapWriteError("Failed to create passkey credential"),
            Effect.asVoid,
          ),

      listPasskeyCredentialsForUser: (userId: string) =>
        db
          .select({
            id: schema.passkeyCredential.id,
            name: schema.passkeyCredential.passkeyName,
            createdAt: schema.passkeyCredential.createdAt,
            lastUsedAt: schema.passkeyCredential.passkeyLastUsedAt,
            credentialId: schema.passkeyCredential.passkeyCredentialId,
            transports: schema.passkeyCredential.passkeyTransports,
          })
          .from(schema.passkeyCredential)
          .where(
            and(
              eq(schema.passkeyCredential.userId, userId),
              eq(schema.passkeyCredential._deleted, false),
            ),
          )
          .orderBy(
            asc(schema.passkeyCredential.createdAt),
            asc(schema.passkeyCredential.id),
          )
          .pipe(
            Effect.map((rows): readonly PasskeyManagementCredential[] =>
              rows.map((row) => {
                const transports = Array.isArray(row.transports)
                  ? row.transports.filter(
                      (transport): transport is string =>
                        typeof transport === "string",
                    )
                  : undefined
                return {
                  id: row.id,
                  name: row.name,
                  createdAt: row.createdAt,
                  lastUsedAt: row.lastUsedAt ?? null,
                  credentialId: row.credentialId,
                  ...(transports && { transports }),
                }
              }),
            ),
            mapQueryError("Failed to list passkey credentials"),
          ),

      renamePasskeyCredential: (input: {
        readonly userId: string
        readonly id: string
        readonly name: string
      }) =>
        db
          .update(schema.passkeyCredential)
          .set({ passkeyName: input.name })
          .where(
            and(
              eq(schema.passkeyCredential.id, input.id),
              eq(schema.passkeyCredential.userId, input.userId),
              eq(schema.passkeyCredential._deleted, false),
            ),
          )
          .returning({ id: schema.passkeyCredential.id })
          .pipe(Effect.map((rows) => rows.length === 1))
          .pipe(mapWriteError("Failed to rename passkey credential")),

      removePasskeyCredential: (input: {
        readonly userId: string
        readonly id: string
      }) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now
          const removed = yield* db
            .update(schema.passkeyCredential)
            .set({
              _deleted: true,
              updatedAt: now,
              updatedBy: "SYSTEM",
            })
            .where(
              and(
                eq(schema.passkeyCredential.id, input.id),
                eq(schema.passkeyCredential.userId, input.userId),
                eq(schema.passkeyCredential._deleted, false),
                // Lock every active credential for this account, then delete
                // only when another active credential remains. FOR UPDATE is
                // valid in this derived FROM-style subquery and serializes
                // concurrent last-two removals.
                sql`(
                  select count(*) from (
                    select id from pf_passkey_credential as remaining
                    where remaining.user_id = ${input.userId}
                      and remaining._deleted = false
                    for update
                  ) locked
                ) > 1`,
              ),
            )
            .returning({ id: schema.passkeyCredential.id })
            .pipe(mapWriteError("Failed to remove passkey credential"))
          if (removed.length === 1) return "removed" as const
          const remaining = yield* db
            .select({ id: schema.passkeyCredential.id })
            .from(schema.passkeyCredential)
            .where(
              and(
                eq(schema.passkeyCredential.id, input.id),
                eq(schema.passkeyCredential.userId, input.userId),
                eq(schema.passkeyCredential._deleted, false),
              ),
            )
            .limit(1)
            .pipe(mapWriteError("Failed to remove passkey credential"))
          const result: RemovePasskeyCredentialResult =
            remaining.length === 1 ? "last_credential" : "not_found"
          return result
        }),

      advancePasskeyCredentialCounter: (
        credentialId: string,
        expectedCounter: number,
        newCounter: number,
        lastUsedAt?: DateTime.Utc,
      ) =>
        db
          .update(schema.passkeyCredential)
          .set({
            signatureCounter: String(newCounter),
            ...(lastUsedAt !== undefined && { passkeyLastUsedAt: lastUsedAt }),
          })
          .where(
            and(
              eq(schema.passkeyCredential.passkeyCredentialId, credentialId),
              eq(
                schema.passkeyCredential.signatureCounter,
                String(expectedCounter),
              ),
              eq(schema.passkeyCredential._deleted, false),
            ),
          )
          .returning({ id: schema.passkeyCredential.id })
          .pipe(Effect.map((rows) => rows.length === 1))
          .pipe(mapWriteError("Failed to advance passkey credential counter")),

      updateLastLoggedIn: (userId: string, lastLoggedIn: DateTime.Utc) =>
        db
          .update(schema.user)
          .set({ lastLoggedIn })
          .where(eq(schema.user.id, userId))
          .pipe(
            mapWriteError("Failed to update last logged in"),
            Effect.asVoid,
          ),

      updateProviderUserProfilePicture: (userId: string, picture: string) =>
        db
          .update(schema.providerUser)
          .set({ picture })
          .where(eq(schema.providerUser.userId, userId))
          .pipe(
            mapWriteError("Failed to update provider user profile picture"),
            Effect.asVoid,
          ),

      findAllOAuthProviders: () =>
        Effect.gen(function* () {
          const results = yield* db
            .select({
              name: schema.oauthProvider.providerName,
              config: schema.oauthProvider.providerConfig,
            })
            .from(schema.oauthProvider)
            .where(eq(schema.oauthProvider._deleted, false))

          return results.map((row) => ({
            name: row.name,
            config: row.config as unknown as OAuthProviderConfig,
          }))
        }).pipe(mapQueryError("Failed to list OAuth providers")),

      findOAuthProviderByName: (name: string) =>
        Effect.gen(function* () {
          const results = yield* db
            .select({
              name: schema.oauthProvider.providerName,
              config: schema.oauthProvider.providerConfig,
            })
            .from(schema.oauthProvider)
            .where(
              and(
                eq(schema.oauthProvider.providerName, name),
                eq(schema.oauthProvider._deleted, false),
              ),
            )
            .limit(1)
          const row = results[0]
          return row
            ? Option.some({
                name: row.name,
                config: row.config as unknown as OAuthProviderConfig,
              })
            : Option.none()
        }).pipe(mapQueryError("Failed to find OAuth provider")),

      findProviderUserRoles: (userId: string) =>
        Effect.gen(function* () {
          // Join through provider_user table to find roles by userId
          const results = yield* db
            .select({ path: schema.role.path })
            .from(schema.providerUserRole)
            .innerJoin(
              schema.providerUser,
              eq(
                schema.providerUserRole.providerUserId,
                schema.providerUser.id,
              ),
            )
            .innerJoin(
              schema.role,
              eq(schema.providerUserRole.roleId, schema.role.id),
            )
            .where(
              and(
                eq(schema.providerUser.userId, userId),
                eq(schema.providerUserRole._deleted, false),
                eq(schema.providerUser._deleted, false),
                eq(schema.role._deleted, false),
              ),
            )

          return results.map((r) => r.path)
        }).pipe(mapQueryError("Failed to find provider user roles")),

      findInvitationRoleIds: (email: string) =>
        Effect.gen(function* () {
          // Pending Invitation only: historical accepted/legacy-closed rows
          // must not re-grant roles on a later bootstrap of the same email.
          const normalizedEmail = email.toLowerCase()
          const results = yield* db
            .select({ roleId: schema.invitationRole.roleId })
            .from(schema.invitation)
            .innerJoin(
              schema.invitationRole,
              eq(schema.invitationRole.invitationId, schema.invitation.id),
            )
            .innerJoin(
              schema.role,
              eq(schema.role.id, schema.invitationRole.roleId),
            )
            .where(
              and(
                eq(schema.invitation.invitationPendingEmail, normalizedEmail),
                eq(schema.invitation.invitationStatus, "pending"),
                eq(schema.invitation._deleted, false),
                eq(schema.invitationRole._deleted, false),
                eq(schema.role._deleted, false),
              ),
            )

          return results.map((r) => r.roleId)
        }).pipe(mapQueryError("Failed to find invitation role ids")),

      hasPendingInvitation: (email: string) =>
        Effect.gen(function* () {
          const normalizedEmail = email.toLowerCase()
          const results = yield* db
            .select({ id: schema.invitation.id })
            .from(schema.invitation)
            .where(
              and(
                eq(schema.invitation.invitationPendingEmail, normalizedEmail),
                eq(schema.invitation.invitationStatus, "pending"),
                eq(schema.invitation._deleted, false),
              ),
            )
            .limit(1)
          return results.length > 0
        }).pipe(mapQueryError("Failed to check pending invitation")),

      acceptPendingInvitationForUser: (input) =>
        Effect.gen(function* () {
          const normalizedEmail = input.email.toLowerCase()
          const providerUserRows = yield* db
            .select({ id: schema.providerUser.id })
            .from(schema.providerUser)
            .where(
              and(
                eq(schema.providerUser.userId, input.userId),
                eq(schema.providerUser._deleted, false),
              ),
            )
            .limit(1)

          const providerUser = providerUserRows[0]
          if (!providerUser) {
            return yield* new ProviderUserNotFoundError({
              userId: input.userId,
            })
          }

          const pinPredicates = input.invitationPin
            ? [
                eq(schema.invitation.id, input.invitationPin.invitationId),
                sql`coalesce(${schema.invitation.registrationLinkGeneration}, 0) = ${input.invitationPin.linkGeneration}`,
              ]
            : []

          const accepted = yield* db
            .update(schema.invitation)
            .set({
              invitationStatus: "accepted",
              invitationPendingEmail: null,
              invitationAcceptedAt: input.acceptedAt,
              invitationAcceptedByProvider: input.provider,
              invitationAcceptedBySubject: input.subject,
              acceptedByProviderUserId: providerUser.id,
              // Clear live Registration Link authority on acceptance.
              registrationTokenHash: null,
              registrationEncryptionVersion: null,
              registrationEncryptionNonce: null,
              registrationAuthenticationTag: null,
              registrationEncryptedToken: null,
              registrationLinkExpiresAt: null,
              registrationLinkGeneration: sql`coalesce(${schema.invitation.registrationLinkGeneration}, 0) + 1`,
              updatedAt: input.acceptedAt,
              updatedBy: "SYSTEM",
            })
            .where(
              and(
                eq(schema.invitation.invitationPendingEmail, normalizedEmail),
                eq(schema.invitation.invitationStatus, "pending"),
                eq(schema.invitation._deleted, false),
                ...pinPredicates,
              ),
            )
            .returning({ id: schema.invitation.id })

          const acceptedInvitation = accepted[0]
          if (acceptedInvitation) {
            yield* db
              .update(schema.registrationSession)
              .set({
                _deleted: true,
                updatedAt: input.acceptedAt,
                updatedBy: "SYSTEM",
              })
              .where(
                and(
                  eq(
                    schema.registrationSession.invitationId,
                    acceptedInvitation.id,
                  ),
                  eq(schema.registrationSession._deleted, false),
                ),
              )
          }

          return accepted.length > 0
        }).pipe(mapWriteError("Failed to accept pending invitation")),

      exchangeRegistrationLink: (rawToken: string) =>
        Effect.gen(function* () {
          const tokenHash = hashBearerToken(rawToken)
          const now = yield* DateTime.now

          const passkeyEnabled = yield* db
            .select({ id: schema.oauthProvider.id })
            .from(schema.oauthProvider)
            .where(
              and(
                eq(schema.oauthProvider.providerName, "passkey"),
                eq(schema.oauthProvider._deleted, false),
              ),
            )
            .limit(1)
          if (passkeyEnabled.length === 0) {
            return Option.none<RegistrationSessionExchangeResult>()
          }

          const invitationRows = yield* db
            .select({
              id: schema.invitation.id,
              email: schema.invitation.email,
              generation: schema.invitation.registrationLinkGeneration,
              expiresAt: schema.invitation.registrationLinkExpiresAt,
              pendingEmail: schema.invitation.invitationPendingEmail,
            })
            .from(schema.invitation)
            .where(
              and(
                eq(schema.invitation.registrationTokenHash, tokenHash),
                eq(schema.invitation.invitationStatus, "pending"),
                eq(schema.invitation._deleted, false),
              ),
            )
            .limit(1)

          const invitation = invitationRows[0]
          if (
            !invitation ||
            invitation.generation === null ||
            !invitation.expiresAt ||
            !invitation.pendingEmail
          ) {
            return Option.none<RegistrationSessionExchangeResult>()
          }

          if (DateTime.lessThanOrEqualTo(invitation.expiresAt, now)) {
            return Option.none<RegistrationSessionExchangeResult>()
          }

          const roleRows = yield* db
            .select({ roleId: schema.invitationRole.roleId })
            .from(schema.invitationRole)
            .innerJoin(
              schema.role,
              eq(schema.role.id, schema.invitationRole.roleId),
            )
            .where(
              and(
                eq(schema.invitationRole.invitationId, invitation.id),
                eq(schema.invitationRole._deleted, false),
                eq(schema.role._deleted, false),
              ),
            )
            .limit(1)
          if (roleRows.length === 0) {
            return Option.none<RegistrationSessionExchangeResult>()
          }

          const ownerRows = yield* db
            .select({ id: schema.providerUser.id })
            .from(schema.providerUser)
            .where(
              and(
                eq(schema.providerUser.email, invitation.pendingEmail),
                eq(schema.providerUser._deleted, false),
              ),
            )
            .limit(1)
          if (ownerRows.length > 0) {
            return Option.none<RegistrationSessionExchangeResult>()
          }

          const { rawBearer, tokenHash: sessionHash } =
            generateRegistrationSessionBearer()
          const expiresAt = DateTime.add(now, {
            minutes: REGISTRATION_SESSION_TTL_MINUTES,
          })

          yield* db.insert(schema.registrationSession).values({
            registrationSessionTokenHash: sessionHash,
            invitationId: invitation.id,
            registrationLinkGeneration: invitation.generation,
            registrationSessionExpiresAt: expiresAt,
            createdAt: now,
            updatedAt: now,
            createdBy: "SYSTEM",
            updatedBy: "SYSTEM",
          })

          return Option.some({
            email: invitation.pendingEmail,
            sessionBearer: rawBearer,
            expiresAt,
            invitationId: invitation.id,
            linkGeneration: invitation.generation,
          } satisfies RegistrationSessionExchangeResult)
        }).pipe(mapWriteError("Failed to exchange registration link")),

      resolveInvitationRegistrationSession: (sessionBearer: string) =>
        Effect.gen(function* () {
          const sessionHash = hashBearerToken(sessionBearer)
          const now = yield* DateTime.now

          const passkeyEnabled = yield* db
            .select({ id: schema.oauthProvider.id })
            .from(schema.oauthProvider)
            .where(
              and(
                eq(schema.oauthProvider.providerName, "passkey"),
                eq(schema.oauthProvider._deleted, false),
              ),
            )
            .limit(1)
          if (passkeyEnabled.length === 0) {
            return Option.none<InvitationRegistrationSessionContext>()
          }

          const sessionRows = yield* db
            .select({
              sessionId: schema.registrationSession.id,
              sessionHash:
                schema.registrationSession.registrationSessionTokenHash,
              sessionGeneration:
                schema.registrationSession.registrationLinkGeneration,
              sessionExpiresAt:
                schema.registrationSession.registrationSessionExpiresAt,
              invitationId: schema.invitation.id,
              pendingEmail: schema.invitation.invitationPendingEmail,
              invitationStatus: schema.invitation.invitationStatus,
              invitationDeleted: schema.invitation._deleted,
              linkGeneration: schema.invitation.registrationLinkGeneration,
            })
            .from(schema.registrationSession)
            .innerJoin(
              schema.invitation,
              eq(schema.invitation.id, schema.registrationSession.invitationId),
            )
            .where(
              and(
                eq(
                  schema.registrationSession.registrationSessionTokenHash,
                  sessionHash,
                ),
                eq(schema.registrationSession._deleted, false),
                gt(
                  schema.registrationSession.registrationSessionExpiresAt,
                  now,
                ),
              ),
            )
            .limit(1)

          const row = sessionRows[0]
          if (
            !row ||
            row.invitationDeleted ||
            row.invitationStatus !== "pending" ||
            !row.pendingEmail ||
            row.linkGeneration === null ||
            row.sessionGeneration !== row.linkGeneration
          ) {
            return Option.none<InvitationRegistrationSessionContext>()
          }

          const roleRows = yield* db
            .select({ roleId: schema.invitationRole.roleId })
            .from(schema.invitationRole)
            .innerJoin(
              schema.role,
              eq(schema.role.id, schema.invitationRole.roleId),
            )
            .where(
              and(
                eq(schema.invitationRole.invitationId, row.invitationId),
                eq(schema.invitationRole._deleted, false),
                eq(schema.role._deleted, false),
              ),
            )
            .limit(1)
          if (roleRows.length === 0) {
            return Option.none<InvitationRegistrationSessionContext>()
          }

          const ownerRows = yield* db
            .select({ id: schema.providerUser.id })
            .from(schema.providerUser)
            .where(
              and(
                eq(schema.providerUser.email, row.pendingEmail),
                eq(schema.providerUser._deleted, false),
              ),
            )
            .limit(1)
          if (ownerRows.length > 0) {
            return Option.none<InvitationRegistrationSessionContext>()
          }

          return Option.some({
            email: row.pendingEmail,
            invitationId: row.invitationId,
            linkGeneration: row.linkGeneration,
            sessionTokenHash: row.sessionHash,
            sessionId: row.sessionId,
          } satisfies InvitationRegistrationSessionContext)
        }).pipe(mapQueryError("Failed to resolve registration session")),

      deleteRegistrationSessionsForInvitation: (invitationId: string) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now
          yield* db
            .update(schema.registrationSession)
            .set({
              _deleted: true,
              updatedAt: now,
              updatedBy: "SYSTEM",
            })
            .where(
              and(
                eq(schema.registrationSession.invitationId, invitationId),
                eq(schema.registrationSession._deleted, false),
              ),
            )
        }).pipe(mapWriteError("Failed to delete registration sessions")),

      findRoleIdsByPaths: (paths: readonly string[]) =>
        Effect.gen(function* () {
          if (paths.length === 0) return []
          const results = yield* db
            .select({ id: schema.role.id })
            .from(schema.role)
            .where(
              and(
                inArray(schema.role.path, paths as string[]),
                eq(schema.role._deleted, false),
              ),
            )
          return results.map((r) => r.id)
        }).pipe(mapQueryError("Failed to find role ids by paths")),

      assignProviderUserRoles: (providerUserId: string, roleIds: string[]) =>
        Effect.gen(function* () {
          if (roleIds.length === 0) return

          // First, find the provider user record by userId (since providerUserId is actually userId)
          const providerUserResults = yield* db
            .select({ id: schema.providerUser.id })
            .from(schema.providerUser)
            .where(
              and(
                eq(schema.providerUser.userId, providerUserId),
                eq(schema.providerUser._deleted, false),
              ),
            )
            .limit(1)

          const providerUser = providerUserResults[0]
          if (!providerUser) {
            return yield* new ProviderUserNotFoundError({
              userId: providerUserId,
            })
          }

          const now = yield* DateTime.now

          // Insert provider_user_role records
          yield* db.insert(schema.providerUserRole).values(
            roleIds.map((roleId) => ({
              providerUserId: providerUser.id,
              roleId,
              createdAt: now,
              updatedAt: now,
            })),
          )
        }).pipe(mapWriteError("Failed to assign provider user roles")),

      findAllOAuthClients: () =>
        Effect.gen(function* () {
          const results = yield* db
            .select({
              clientId: schema.oauthClient.clientId,
              secretHash: schema.oauthClient.clientSecretHash,
              audience: schema.oauthClient.audience,
            })
            .from(schema.oauthClient)
            .where(eq(schema.oauthClient._deleted, false))

          return results satisfies OAuthClientRecord[]
        }).pipe(mapQueryError("Failed to list OAuth clients")),

      findOAuthClientById: (clientId: string) =>
        Effect.gen(function* () {
          const results = yield* db
            .select({
              clientId: schema.oauthClient.clientId,
              secretHash: schema.oauthClient.clientSecretHash,
              audience: schema.oauthClient.audience,
            })
            .from(schema.oauthClient)
            .where(
              and(
                eq(schema.oauthClient.clientId, clientId),
                eq(schema.oauthClient._deleted, false),
              ),
            )
            .limit(1)

          const row = results[0]
          return row ? Option.some(row) : Option.none()
        }).pipe(mapQueryError("Failed to find OAuth client")),

      validateRolePaths: (paths: readonly string[]) =>
        Effect.gen(function* () {
          if (paths.length === 0) {
            return []
          }
          // Cast needed: drizzle's inArray requires mutable array, but we only read
          const results = yield* db
            .select({ path: schema.role.path })
            .from(schema.role)
            .where(
              and(
                inArray(schema.role.path, paths as string[]),
                eq(schema.role._deleted, false),
              ),
            )

          return results.map((r) => r.path)
        }).pipe(mapQueryError("Failed to validate role paths")),

      upsertM2MUser: (
        clientId: string,
        lastLoggedIn: DateTime.Utc,
        options?: { readonly updateLastLoggedIn?: boolean },
      ) =>
        Effect.gen(function* () {
          const M2M_PROVIDER = "client_credentials"
          const shouldUpdateLastLoggedIn = options?.updateLastLoggedIn !== false

          // Try to find existing M2M user
          const existing = yield* db
            .select({ id: schema.user.id })
            .from(schema.user)
            .where(
              and(
                eq(schema.user.provider, M2M_PROVIDER),
                eq(schema.user.sub, clientId),
                eq(schema.user._deleted, false),
              ),
            )
            .limit(1)

          if (existing[0]) {
            if (shouldUpdateLastLoggedIn) {
              // Update last_logged_in for existing user
              yield* db
                .update(schema.user)
                .set({
                  lastLoggedIn,
                  updatedAt: lastLoggedIn,
                })
                .where(eq(schema.user.id, existing[0].id))
            }

            return existing[0].id
          }

          // Create new M2M user
          const result = yield* db
            .insert(schema.user)
            .values({
              provider: M2M_PROVIDER,
              sub: clientId,
              lastLoggedIn,
              createdAt: lastLoggedIn,
              updatedAt: lastLoggedIn,
              createdBy: "SYSTEM",
              updatedBy: "SYSTEM",
            })
            .returning({ id: schema.user.id })

          return (yield* returnedRow(result)).id
        }).pipe(mapWriteError("Failed to upsert M2M user")),

      findPermittedRolesWithOrgUnit: (userId: string) =>
        Effect.gen(function* () {
          // Join through provider_user table to find permitted roles by userId
          // Also join org_unit to get the org unit path for each role
          const results = yield* db
            .select({
              rolePath: schema.role.path,
              orgUnitId: schema.role.orgUnitId,
              orgUnitPath: schema.orgUnit.path,
            })
            .from(schema.permittedRole)
            .innerJoin(
              schema.providerUser,
              eq(schema.permittedRole.providerUserId, schema.providerUser.id),
            )
            .innerJoin(
              schema.role,
              eq(schema.permittedRole.roleId, schema.role.id),
            )
            .innerJoin(
              schema.orgUnit,
              eq(schema.role.orgUnitId, schema.orgUnit.id),
            )
            .where(
              and(
                eq(schema.providerUser.userId, userId),
                eq(schema.permittedRole._deleted, false),
                eq(schema.providerUser._deleted, false),
                eq(schema.role._deleted, false),
                eq(schema.orgUnit._deleted, false),
              ),
            )

          return results
        }).pipe(mapQueryError("Failed to find permitted roles")),

      findOrgUnitByPath: (path: string) =>
        Effect.gen(function* () {
          const results = yield* db
            .select()
            .from(schema.orgUnit)
            .where(eq(schema.orgUnit.path, path))
            .limit(1)

          const orgUnit = results[0]
          if (!orgUnit) {
            return Option.none<OrgUnitRecord>()
          }

          return Option.some(toOrgUnitRecord(orgUnit))
        }).pipe(mapQueryError("Failed to find organization unit by path")),

      validateRolePathsWithOrgUnit: (paths: readonly string[]) =>
        Effect.gen(function* () {
          if (paths.length === 0) {
            return []
          }
          // Join role with org_unit to get org unit path for each role
          const results = yield* db
            .select({
              rolePath: schema.role.path,
              orgUnitId: schema.role.orgUnitId,
              orgUnitPath: schema.orgUnit.path,
            })
            .from(schema.role)
            .innerJoin(
              schema.orgUnit,
              eq(schema.role.orgUnitId, schema.orgUnit.id),
            )
            .where(
              and(
                inArray(schema.role.path, paths as string[]),
                eq(schema.role._deleted, false),
                eq(schema.orgUnit._deleted, false),
              ),
            )

          return results
        }).pipe(mapQueryError("Failed to validate role paths with org unit")),

      findPermittedClientRole: (clientId: string, rolePath: string) =>
        Effect.gen(function* () {
          // Look up oauth_client by clientId, then join permitted_client_role,
          // role, and org_unit to get the permitted role info
          const results = yield* db
            .select({
              rolePath: schema.role.path,
              orgUnitId: schema.role.orgUnitId,
              orgUnitPath: schema.orgUnit.path,
              updatedAt: schema.permittedClientRole.updatedAt,
            })
            .from(schema.oauthClient)
            .innerJoin(
              schema.permittedClientRole,
              eq(
                schema.permittedClientRole.oauthClientId,
                schema.oauthClient.id,
              ),
            )
            .innerJoin(
              schema.role,
              eq(schema.permittedClientRole.roleId, schema.role.id),
            )
            .innerJoin(
              schema.orgUnit,
              eq(schema.role.orgUnitId, schema.orgUnit.id),
            )
            .where(
              and(
                eq(schema.oauthClient.clientId, clientId),
                eq(schema.role.path, rolePath),
                eq(schema.oauthClient._deleted, false),
                eq(schema.permittedClientRole._deleted, false),
                eq(schema.role._deleted, false),
                eq(schema.orgUnit._deleted, false),
              ),
            )
            .limit(1)

          const row = results[0]
          if (!row) {
            return Option.none()
          }

          return Option.some({
            rolePath: row.rolePath,
            orgUnitId: row.orgUnitId,
            orgUnitPath: row.orgUnitPath,
            updatedAt: row.updatedAt,
          })
        }).pipe(mapQueryError("Failed to find permitted client role")),

      findPermittedClientEmail: (clientId: string, email: string) =>
        Effect.gen(function* () {
          // Look up oauth_client by clientId, then join permitted_client_email
          const results = yield* db
            .select({
              email: schema.permittedClientEmail.email,
              updatedAt: schema.permittedClientEmail.updatedAt,
            })
            .from(schema.oauthClient)
            .innerJoin(
              schema.permittedClientEmail,
              eq(
                schema.permittedClientEmail.oauthClientId,
                schema.oauthClient.id,
              ),
            )
            .where(
              and(
                eq(schema.oauthClient.clientId, clientId),
                eq(schema.permittedClientEmail.email, email),
                eq(schema.oauthClient._deleted, false),
                eq(schema.permittedClientEmail._deleted, false),
              ),
            )
            .limit(1)

          const row = results[0]
          if (!row) {
            return Option.none()
          }

          return Option.some({
            email: row.email,
            updatedAt: row.updatedAt,
          })
        }).pipe(mapQueryError("Failed to find permitted client email")),
    }
  }),
)

const mapSqlToStorageError = <A, R>(
  effect: Effect.Effect<A, import("@effect/sql/SqlError").SqlError, R>,
): Effect.Effect<A, StorageError, R> =>
  effect.pipe(
    Effect.mapError((e) => new StorageError({ message: e.message, cause: e })),
  )

export const PostgresOpenAuthStorageServiceLive = Layer.effect(
  StorageService,
  Effect.gen(function* () {
    const db = yield* TypedPostgresDrizzle

    return {
      get: <T>(key: string[]) =>
        mapSqlToStorageError(
          Effect.gen(function* () {
            const keyStr = joinKey(key)
            const now = yield* DateTime.now

            const result = yield* db
              .select()
              .from(schema.oauthStorage)
              .where(
                and(
                  eq(schema.oauthStorage.oauthKey, keyStr),
                  or(
                    isNull(schema.oauthStorage.keyExpiry),
                    gt(schema.oauthStorage.keyExpiry, now),
                  ),
                ),
              )
              .limit(1)

            if (result.length === 0) return undefined

            const row = result[0]
            if (!row) return undefined

            return row.keyValue as T
          }),
        ),
      take: <T>(key: string[]) =>
        mapSqlToStorageError(
          Effect.gen(function* () {
            const keyStr = joinKey(key)
            const now = yield* DateTime.now

            const rows = yield* db
              .delete(schema.oauthStorage)
              .where(
                and(
                  eq(schema.oauthStorage.oauthKey, keyStr),
                  or(
                    isNull(schema.oauthStorage.keyExpiry),
                    gt(schema.oauthStorage.keyExpiry, now),
                  ),
                ),
              )
              .returning({ value: schema.oauthStorage.keyValue })

            return rows[0]?.value as T | undefined
          }),
        ),
      set: (key: string[], value: unknown, ttl?: number) =>
        mapSqlToStorageError(
          Effect.gen(function* () {
            const keyStr = joinKey(key)
            const storageType = extractStorageType(key)
            const expiryUtc =
              ttl === undefined
                ? undefined
                : DateTime.unsafeMake(Date.now() + ttl * 1000)

            yield* db
              .insert(schema.oauthStorage)
              .values({
                oauthKey: keyStr,
                keyKind: storageType,
                keyValue: value as OAuthStorageValue,
                keyExpiry: expiryUtc,
              })
              .onConflictDoUpdate({
                target: schema.oauthStorage.oauthKey,
                set: {
                  keyValue: value as OAuthStorageValue,
                  keyKind: storageType,
                  keyExpiry: expiryUtc,
                },
              })
          }),
        ),
      remove: (key: string[]) =>
        mapSqlToStorageError(
          Effect.gen(function* () {
            const keyStr = joinKey(key)

            yield* db
              .delete(schema.oauthStorage)
              .where(eq(schema.oauthStorage.oauthKey, keyStr))
          }),
        ),
      scan: <T>(prefix: string[]) =>
        Stream.unwrap(
          mapSqlToStorageError(
            Effect.gen(function* () {
              const prefixStr = joinKey(prefix)
              const prefixEnd = prefixUpperBound(prefixStr)
              const now = yield* DateTime.now

              const rows = yield* db
                .select()
                .from(schema.oauthStorage)
                .where(
                  and(
                    gte(schema.oauthStorage.oauthKey, prefixStr),
                    lt(schema.oauthStorage.oauthKey, prefixEnd),
                    or(
                      isNull(schema.oauthStorage.keyExpiry),
                      gt(schema.oauthStorage.keyExpiry, now),
                    ),
                  ),
                )

              return Stream.fromIterable(
                rows.map(
                  (row) =>
                    [splitKey(row.oauthKey), row.keyValue as T] as [
                      string[],
                      T,
                    ],
                ),
              )
            }),
          ),
        ),
    }
  }),
)
