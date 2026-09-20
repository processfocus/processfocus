import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm"
import { DateTime, Effect, Layer } from "effect"
import * as schema from "@pf/drizzle-sqlite"
import {
  type CreateInvitationInput,
  type GrantRoleResult,
  InvitationLifecycleStatus,
  InvitationSource,
  type LiveRegistrationLinkRow,
  type NotificationPreferences,
  type PaginatedResult,
  type RegistrationLinkPersistence,
  RegistrationLinkStatus,
  type SettingsInvitationRow,
  type SettingsOAuthProviderRow,
  SettingsQueries,
  type SettingsRoleRow,
  type SettingsUserRow,
  type UpdateInvitationInput,
  defaultNotificationPreferences,
  parseNotificationPreferences,
  returnedRow,
  serializeNotificationPreferences,
} from "@pf/graphql-db-operations"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"

const isActiveProviderUserRoleConflict = (error: unknown): boolean => {
  const message = String(error)
  // Duplicate active grants should be treated as an idempotent no-op.
  // Match the current unique index/constraint text so concurrent grants do
  // not surface a SQL error from the CLI.
  return (
    message.includes("pf_provider_user_role_provideruserroleidx_idx") ||
    message.includes(
      "UNIQUE constraint failed: pf_provider_user_role.provider_user_id, pf_provider_user_role.role_id",
    )
  )
}

/**
 * SQLite implementation of SettingsQueries service
 */
export const SqliteSettingsQueriesLive = Layer.effect(
  SettingsQueries,
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle

    const loadInvitationRoles = (invitationId: string) =>
      Effect.gen(function* () {
        const roleResults = yield* db
          .select({
            id: schema.role.id,
            name: schema.role.name,
            path: schema.role.path,
          })
          .from(schema.invitationRole)
          .innerJoin(
            schema.role,
            eq(schema.role.id, schema.invitationRole.roleId),
          )
          .where(
            and(
              eq(schema.invitationRole.invitationId, invitationId),
              eq(schema.invitationRole._deleted, false),
              eq(schema.role._deleted, false),
            ),
          )
          .orderBy(schema.role.path)

        return roleResults as SettingsRoleRow[]
      })

    const toLifecycleStatus = (
      status: string,
    ): SettingsInvitationRow["status"] => {
      if (status === InvitationLifecycleStatus.Accepted) {
        return InvitationLifecycleStatus.Accepted
      }
      if (status === InvitationLifecycleStatus.LegacyClosed) {
        return InvitationLifecycleStatus.LegacyClosed
      }
      return InvitationLifecycleStatus.Pending
    }

    const toInvitationSource = (
      source: string,
    ): SettingsInvitationRow["source"] => {
      if (source === InvitationSource.Model) {
        return InvitationSource.Model
      }
      if (source === InvitationSource.Dashboard) {
        return InvitationSource.Dashboard
      }
      if (source === InvitationSource.Process) {
        return InvitationSource.Process
      }
      return InvitationSource.Legacy
    }

    const toUtcDate = (value: DateTime.Utc | null): Date | null =>
      value ? DateTime.toDateUtc(value) : null

    const deriveRegistrationLinkStatus = (input: {
      readonly lifecycleStatus: SettingsInvitationRow["status"]
      readonly tokenHash: string | null
      readonly expiresAt: DateTime.Utc | null
      readonly revokedAt: DateTime.Utc | null
      readonly now: DateTime.Utc
    }): RegistrationLinkStatus => {
      if (input.lifecycleStatus !== InvitationLifecycleStatus.Pending) {
        return RegistrationLinkStatus.NotGenerated
      }
      if (input.tokenHash) {
        if (
          input.expiresAt &&
          DateTime.toEpochMillis(input.expiresAt) <=
            DateTime.toEpochMillis(input.now)
        ) {
          return RegistrationLinkStatus.Expired
        }
        return RegistrationLinkStatus.Active
      }
      if (input.revokedAt) {
        return RegistrationLinkStatus.Revoked
      }
      return RegistrationLinkStatus.NotGenerated
    }

    const clearRegistrationLinkColumns = {
      registrationTokenHash: null as string | null,
      registrationEncryptionVersion: null as number | null,
      registrationEncryptionNonce: null as string | null,
      registrationAuthenticationTag: null as string | null,
      registrationEncryptedToken: null as string | null,
      registrationLinkExpiresAt: null as DateTime.Utc | null,
      // Advance generation so any Registration Session bound to the previous
      // live link becomes invalid.
      registrationLinkGeneration: sql`coalesce(${schema.invitation.registrationLinkGeneration}, 0) + 1`,
    }

    const buildInvitationRow = (
      row: {
        id: string
        email: string
        invitationStatus: string
        invitationSource: string
        invitationAcceptedAt: DateTime.Utc | null
        invitationAcceptedByProvider: string | null
        invitationAcceptedBySubject: string | null
        acceptedByProviderUserId: string | null
        invitationLegacyClosedAt: DateTime.Utc | null
        invitationLegacyClosureReason: string | null
        registrationTokenHash: string | null
        registrationLinkExpiresAt: DateTime.Utc | null
        registrationLinkGeneratedAt: DateTime.Utc | null
        registrationLinkGeneratedBy: string | null
        registrationLinkRevealedAt: DateTime.Utc | null
        registrationLinkRevealedBy: string | null
        registrationLinkRevokedAt: DateTime.Utc | null
        registrationLinkRevokedBy: string | null
        registrationLinkGeneration: number | null
      },
      now: DateTime.Utc,
    ) =>
      Effect.gen(function* () {
        const roles = yield* loadInvitationRoles(row.id)
        const status = toLifecycleStatus(row.invitationStatus)
        return {
          id: row.id,
          email: row.email,
          status,
          source: toInvitationSource(row.invitationSource),
          roles,
          acceptedAt: toUtcDate(row.invitationAcceptedAt),
          acceptedByProvider: row.invitationAcceptedByProvider,
          acceptedBySubject: row.invitationAcceptedBySubject,
          acceptedByProviderUserId: row.acceptedByProviderUserId,
          legacyClosedAt: toUtcDate(row.invitationLegacyClosedAt),
          legacyClosureReason: row.invitationLegacyClosureReason,
          registrationLinkStatus: deriveRegistrationLinkStatus({
            lifecycleStatus: status,
            tokenHash: row.registrationTokenHash,
            expiresAt: row.registrationLinkExpiresAt,
            revokedAt: row.registrationLinkRevokedAt,
            now,
          }),
          registrationLinkExpiresAt: toUtcDate(row.registrationLinkExpiresAt),
          registrationLinkGeneratedAt: toUtcDate(
            row.registrationLinkGeneratedAt,
          ),
          registrationLinkGeneratedBy: row.registrationLinkGeneratedBy,
          registrationLinkRevealedAt: toUtcDate(row.registrationLinkRevealedAt),
          registrationLinkRevealedBy: row.registrationLinkRevealedBy,
          registrationLinkRevokedAt: toUtcDate(row.registrationLinkRevokedAt),
          registrationLinkRevokedBy: row.registrationLinkRevokedBy,
          registrationLinkGeneration: row.registrationLinkGeneration ?? 0,
        } satisfies SettingsInvitationRow
      })

    const invitationSelect = {
      id: schema.invitation.id,
      email: schema.invitation.email,
      invitationStatus: schema.invitation.invitationStatus,
      invitationSource: schema.invitation.invitationSource,
      invitationAcceptedAt: schema.invitation.invitationAcceptedAt,
      invitationAcceptedByProvider:
        schema.invitation.invitationAcceptedByProvider,
      invitationAcceptedBySubject:
        schema.invitation.invitationAcceptedBySubject,
      acceptedByProviderUserId: schema.invitation.acceptedByProviderUserId,
      invitationLegacyClosedAt: schema.invitation.invitationLegacyClosedAt,
      invitationLegacyClosureReason:
        schema.invitation.invitationLegacyClosureReason,
      registrationTokenHash: schema.invitation.registrationTokenHash,
      registrationLinkExpiresAt: schema.invitation.registrationLinkExpiresAt,
      registrationLinkGeneratedAt:
        schema.invitation.registrationLinkGeneratedAt,
      registrationLinkGeneratedBy:
        schema.invitation.registrationLinkGeneratedBy,
      registrationLinkRevealedAt: schema.invitation.registrationLinkRevealedAt,
      registrationLinkRevealedBy: schema.invitation.registrationLinkRevealedBy,
      registrationLinkRevokedAt: schema.invitation.registrationLinkRevokedAt,
      registrationLinkRevokedBy: schema.invitation.registrationLinkRevokedBy,
      registrationLinkGeneration: schema.invitation.registrationLinkGeneration,
    }

    return {
      queryAllUsers: (page: number, limit: number) =>
        Effect.gen(function* () {
          const offset = (page - 1) * limit

          // Count total users
          const countResult = yield* db
            .select({ count: sql<number>`count(*)` })
            .from(schema.user)
            .where(eq(schema.user._deleted, false))
          const totalCount = countResult[0]?.count ?? 0

          // Query users with LEFT JOIN to provider_user
          const results = yield* db
            .select({
              id: schema.user.id,
              provider: schema.user.provider,
              sub: schema.user.sub,
              lastLoggedIn: schema.user.lastLoggedIn,
              providerUserId: schema.providerUser.id,
              providerUserName: schema.providerUser.name,
              providerUserEmail: schema.providerUser.email,
            })
            .from(schema.user)
            .leftJoin(
              schema.providerUser,
              and(
                eq(schema.providerUser.userId, schema.user.id),
                eq(schema.providerUser._deleted, false),
              ),
            )
            .where(eq(schema.user._deleted, false))
            // Secondary key keeps offset pagination identity-stable when
            // lastLoggedIn values tie (required for Access Snapshot paging).
            .orderBy(desc(schema.user.lastLoggedIn), schema.user.id)
            .limit(limit)
            .offset(offset)

          const items: SettingsUserRow[] = results.map((r) => ({
            id: r.id,
            provider: r.provider,
            sub: r.sub,
            lastLoggedIn: DateTime.toDateUtc(r.lastLoggedIn),
            isProviderUser: r.providerUserId !== null,
            providerUserName: r.providerUserName,
            providerUserEmail: r.providerUserEmail,
          }))

          return {
            items,
            totalCount,
          } satisfies PaginatedResult<SettingsUserRow>
        }),

      queryAllOAuthProviders: (page: number, limit: number) =>
        Effect.gen(function* () {
          const offset = (page - 1) * limit

          // Count total providers
          const countResult = yield* db
            .select({ count: sql<number>`count(*)` })
            .from(schema.oauthProvider)
            .where(eq(schema.oauthProvider._deleted, false))
          const totalCount = countResult[0]?.count ?? 0

          // Query providers
          const results = yield* db
            .select({
              id: schema.oauthProvider.id,
              providerName: schema.oauthProvider.providerName,
            })
            .from(schema.oauthProvider)
            .where(eq(schema.oauthProvider._deleted, false))
            .orderBy(schema.oauthProvider.providerName)
            .limit(limit)
            .offset(offset)

          const items: SettingsOAuthProviderRow[] = results.map((r) => ({
            id: r.id,
            providerName: r.providerName,
          }))

          return {
            items,
            totalCount,
          } satisfies PaginatedResult<SettingsOAuthProviderRow>
        }),

      queryAllInvitations: (
        page: number,
        limit: number,
        status = InvitationLifecycleStatus.Pending,
      ) =>
        Effect.gen(function* () {
          const offset = (page - 1) * limit
          const statusFilter = and(
            eq(schema.invitation._deleted, false),
            eq(schema.invitation.invitationStatus, status),
          )

          const countResult = yield* db
            .select({ count: sql<number>`count(*)` })
            .from(schema.invitation)
            .where(statusFilter)
          const totalCount = countResult[0]?.count ?? 0

          const paginatedInvitations = yield* db
            .select(invitationSelect)
            .from(schema.invitation)
            .where(statusFilter)
            .orderBy(schema.invitation.email)
            .limit(limit)
            .offset(offset)

          const now = yield* DateTime.now
          const items: SettingsInvitationRow[] = []
          for (const invitation of paginatedInvitations) {
            items.push(yield* buildInvitationRow(invitation, now))
          }

          return {
            items,
            totalCount,
          } satisfies PaginatedResult<SettingsInvitationRow>
        }),

      queryInvitationDetail: (invitationId: string) =>
        Effect.gen(function* () {
          const results = yield* db
            .select(invitationSelect)
            .from(schema.invitation)
            .where(
              and(
                eq(schema.invitation.id, invitationId),
                eq(schema.invitation._deleted, false),
              ),
            )
            .limit(1)

          const invitation = results[0]
          if (!invitation) {
            return null
          }

          return yield* buildInvitationRow(invitation, yield* DateTime.now)
        }),

      queryPendingInvitationByEmail: (email: string) =>
        Effect.gen(function* () {
          const results = yield* db
            .select(invitationSelect)
            .from(schema.invitation)
            .where(
              and(
                eq(schema.invitation.invitationPendingEmail, email),
                eq(
                  schema.invitation.invitationStatus,
                  InvitationLifecycleStatus.Pending,
                ),
                eq(schema.invitation._deleted, false),
              ),
            )
            .limit(1)

          const invitation = results[0]
          if (!invitation) {
            return null
          }

          return yield* buildInvitationRow(invitation, yield* DateTime.now)
        }),

      queryInvitationByNormalizedEmail: (email: string) =>
        Effect.gen(function* () {
          const pendingResults = yield* db
            .select(invitationSelect)
            .from(schema.invitation)
            .where(
              and(
                eq(schema.invitation.invitationPendingEmail, email),
                eq(
                  schema.invitation.invitationStatus,
                  InvitationLifecycleStatus.Pending,
                ),
                eq(schema.invitation._deleted, false),
              ),
            )
            .limit(1)

          const pending = pendingResults[0]
          if (pending) {
            return yield* buildInvitationRow(pending, yield* DateTime.now)
          }

          const historicalResults = yield* db
            .select(invitationSelect)
            .from(schema.invitation)
            .where(
              and(
                eq(schema.invitation.email, email),
                eq(schema.invitation._deleted, false),
              ),
            )
            .orderBy(desc(schema.invitation.createdAt))
            .limit(1)

          const historical = historicalResults[0]
          if (!historical) {
            return null
          }

          return yield* buildInvitationRow(historical, yield* DateTime.now)
        }),

      queryUserDetail: (userId: string) =>
        Effect.gen(function* () {
          // Query user with LEFT JOIN to provider_user and user_settings
          const results = yield* db
            .select({
              id: schema.user.id,
              provider: schema.user.provider,
              sub: schema.user.sub,
              lastLoggedIn: schema.user.lastLoggedIn,
              providerUserId: schema.providerUser.id,
              providerUserEmail: schema.providerUser.email,
              providerUserName: schema.providerUser.name,
              providerUserFirstName: schema.providerUser.firstName,
              providerUserLastName: schema.providerUser.lastName,
              notificationPreference:
                schema.userSettings.notificationPreference,
            })
            .from(schema.user)
            .leftJoin(
              schema.providerUser,
              and(
                eq(schema.providerUser.userId, schema.user.id),
                eq(schema.providerUser._deleted, false),
              ),
            )
            .leftJoin(
              schema.userSettings,
              and(
                eq(schema.userSettings.userId, schema.user.id),
                eq(schema.userSettings._deleted, false),
              ),
            )
            .where(
              and(eq(schema.user.id, userId), eq(schema.user._deleted, false)),
            )
            .limit(1)

          const r = results[0]
          if (!r) {
            return null
          }

          // If provider user exists, fetch their role IDs
          let roleIds: string[] = []
          if (r.providerUserId) {
            const roleResults = yield* db
              .select({
                roleId: schema.role.id,
              })
              .from(schema.providerUserRole)
              .innerJoin(
                schema.role,
                and(
                  eq(schema.providerUserRole.roleId, schema.role.id),
                  eq(schema.role._deleted, false),
                ),
              )
              .where(
                and(
                  eq(schema.providerUserRole.providerUserId, r.providerUserId),
                  eq(schema.providerUserRole._deleted, false),
                ),
              )
            roleIds = roleResults.map((rr) => rr.roleId)
          }

          const notificationPreferences = r.notificationPreference
            ? parseNotificationPreferences(r.notificationPreference)
            : defaultNotificationPreferences

          return {
            id: r.id,
            provider: r.provider,
            sub: r.sub,
            lastLoggedIn: DateTime.toDateUtc(r.lastLoggedIn),
            providerUser: r.providerUserId
              ? {
                  id: r.providerUserId,
                  email: r.providerUserEmail ?? "",
                  name: r.providerUserName ?? "",
                  firstName: r.providerUserFirstName ?? "",
                  lastName: r.providerUserLastName ?? "",
                  roleIds,
                  notificationPreferences,
                }
              : null,
          }
        }),

      queryProviderUserDetail: (providerUserId: string) =>
        Effect.gen(function* () {
          const results = yield* db
            .select({
              id: schema.providerUser.id,
              email: schema.providerUser.email,
              name: schema.providerUser.name,
              firstName: schema.providerUser.firstName,
              lastName: schema.providerUser.lastName,
              notificationPreference:
                schema.userSettings.notificationPreference,
            })
            .from(schema.providerUser)
            .leftJoin(
              schema.userSettings,
              and(
                eq(schema.userSettings.userId, schema.providerUser.userId),
                eq(schema.userSettings._deleted, false),
              ),
            )
            .where(
              and(
                eq(schema.providerUser.id, providerUserId),
                eq(schema.providerUser._deleted, false),
              ),
            )
            .limit(1)

          const r = results[0]
          if (!r) {
            return null
          }

          const roleResults = yield* db
            .select({
              roleId: schema.role.id,
            })
            .from(schema.providerUserRole)
            .innerJoin(
              schema.role,
              and(
                eq(schema.providerUserRole.roleId, schema.role.id),
                eq(schema.role._deleted, false),
              ),
            )
            .where(
              and(
                eq(schema.providerUserRole.providerUserId, providerUserId),
                eq(schema.providerUserRole._deleted, false),
              ),
            )

          const notificationPreferences = r.notificationPreference
            ? parseNotificationPreferences(r.notificationPreference)
            : defaultNotificationPreferences

          return {
            id: r.id,
            email: r.email ?? "",
            name: r.name ?? "",
            firstName: r.firstName ?? "",
            lastName: r.lastName ?? "",
            roleIds: roleResults.map((rr) => rr.roleId),
            notificationPreferences,
          }
        }),

      queryAllRoles: () =>
        Effect.gen(function* () {
          const results = yield* db
            .select({
              id: schema.role.id,
              name: schema.role.name,
              path: schema.role.path,
            })
            .from(schema.role)
            .where(eq(schema.role._deleted, false))
            .orderBy(schema.role.path)

          return results as SettingsRoleRow[]
        }),

      queryRolesByIds: (roleIds: readonly string[]) =>
        Effect.gen(function* () {
          if (roleIds.length === 0) {
            return []
          }

          const results = yield* db
            .select({
              id: schema.role.id,
              name: schema.role.name,
              path: schema.role.path,
            })
            .from(schema.role)
            .where(
              and(
                inArray(schema.role.id, [...roleIds]),
                eq(schema.role._deleted, false),
              ),
            )

          return results as SettingsRoleRow[]
        }),

      queryPaginatedRoles: (page: number, limit: number) =>
        Effect.gen(function* () {
          const offset = (page - 1) * limit

          const countResult = yield* db
            .select({ count: sql<number>`count(*)` })
            .from(schema.role)
            .where(eq(schema.role._deleted, false))
          const totalCount = countResult[0]?.count ?? 0

          const results = yield* db
            .select({
              id: schema.role.id,
              name: schema.role.name,
              path: schema.role.path,
            })
            .from(schema.role)
            .where(eq(schema.role._deleted, false))
            .orderBy(schema.role.path)
            .limit(limit)
            .offset(offset)

          return {
            items: results as SettingsRoleRow[],
            totalCount,
          } satisfies PaginatedResult<SettingsRoleRow>
        }),

      queryProviderUserRoleIds: (providerUserId: string) =>
        Effect.gen(function* () {
          const results = yield* db
            .select({
              roleId: schema.role.id,
            })
            .from(schema.providerUserRole)
            .innerJoin(
              schema.role,
              and(
                eq(schema.providerUserRole.roleId, schema.role.id),
                eq(schema.role._deleted, false),
              ),
            )
            .where(
              and(
                eq(schema.providerUserRole.providerUserId, providerUserId),
                eq(schema.providerUserRole._deleted, false),
              ),
            )

          return results.map((r) => r.roleId)
        }),

      replaceProviderUserRoles: (
        providerUserId: string,
        roleIds: readonly string[],
      ) =>
        Effect.gen(function* () {
          // Delete existing role assignments
          yield* db
            .delete(schema.providerUserRole)
            .where(eq(schema.providerUserRole.providerUserId, providerUserId))

          // Insert new role assignments if any
          if (roleIds.length > 0) {
            const now = yield* DateTime.now
            const values = roleIds.map((roleId) => ({
              providerUserId,
              roleId,
              createdAt: now,
              updatedAt: now,
              createdBy: "SYSTEM",
              updatedBy: "SYSTEM",
              _deleted: false,
            }))

            yield* db.insert(schema.providerUserRole).values(values)
          }
        }),

      createInvitation: (input: CreateInvitationInput) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now

          const result = yield* db
            .insert(schema.invitation)
            .values({
              invitationId: input.invitationId,
              email: input.email,
              invitationStatus: InvitationLifecycleStatus.Pending,
              invitationSource: input.source,
              invitationPendingEmail: input.email,
              createdAt: now,
              updatedAt: now,
              createdBy: input.createdBy,
              updatedBy: input.updatedBy,
              _deleted: false,
            })
            .returning({ id: schema.invitation.id })

          return (yield* returnedRow(result)).id
        }),

      updateInvitationDetails: (
        invitationId: string,
        input: UpdateInvitationInput,
      ) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now

          // Only pending invitations may be edited.
          const existingRows = yield* db
            .select({
              id: schema.invitation.id,
              email: schema.invitation.email,
            })
            .from(schema.invitation)
            .where(
              and(
                eq(schema.invitation.id, invitationId),
                eq(
                  schema.invitation.invitationStatus,
                  InvitationLifecycleStatus.Pending,
                ),
                eq(schema.invitation._deleted, false),
              ),
            )
            .limit(1)
          const existing = existingRows[0]
          if (!existing) {
            return false
          }

          const emailChanged = existing.email !== input.email

          const updatedInvitations = yield* db
            .update(schema.invitation)
            .set({
              email: input.email,
              invitationPendingEmail: input.email,
              updatedAt: now,
              updatedBy: input.updatedBy,
            })
            .where(
              and(
                eq(schema.invitation.id, invitationId),
                eq(
                  schema.invitation.invitationStatus,
                  InvitationLifecycleStatus.Pending,
                ),
                eq(schema.invitation._deleted, false),
              ),
            )
            .returning({ id: schema.invitation.id })

          if (updatedInvitations.length === 0) {
            return false
          }

          // Invalidate Registration Link only when email actually changes.
          // No-op saves must not revoke a live link.
          if (emailChanged) {
            yield* db
              .update(schema.invitation)
              .set({
                ...clearRegistrationLinkColumns,
                registrationLinkRevokedAt: now,
                registrationLinkRevokedBy: input.updatedBy,
                updatedAt: now,
                updatedBy: input.updatedBy,
              })
              .where(
                and(
                  eq(schema.invitation.id, invitationId),
                  eq(
                    schema.invitation.invitationStatus,
                    InvitationLifecycleStatus.Pending,
                  ),
                  eq(schema.invitation._deleted, false),
                  isNotNull(schema.invitation.registrationTokenHash),
                ),
              )
          }

          return true
        }),

      replaceInvitationRoles: (
        invitationId: string,
        roleIds: readonly string[],
        updatedBy: string,
      ) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now
          // Defense-in-depth: only mutate roles on still-pending invitations.
          const pendingInvitation = yield* db
            .select({ id: schema.invitation.id })
            .from(schema.invitation)
            .where(
              and(
                eq(schema.invitation.id, invitationId),
                eq(
                  schema.invitation.invitationStatus,
                  InvitationLifecycleStatus.Pending,
                ),
                eq(schema.invitation._deleted, false),
              ),
            )
            .limit(1)
          if (pendingInvitation.length === 0) {
            return
          }

          const existingInvitationRoles = yield* db
            .select({
              id: schema.invitationRole.id,
              roleId: schema.invitationRole.roleId,
              deleted: schema.invitationRole._deleted,
            })
            .from(schema.invitationRole)
            .where(eq(schema.invitationRole.invitationId, invitationId))

          const existingByRoleId = new Map(
            existingInvitationRoles.map((invitationRole) => [
              invitationRole.roleId,
              invitationRole,
            ]),
          )
          const desiredRoleIds = new Set(roleIds)
          const existingActiveRoleIds = new Set(
            existingInvitationRoles
              .filter((invitationRole) => !invitationRole.deleted)
              .map((invitationRole) => invitationRole.roleId),
          )
          const rolesChanged =
            roleIds.some((roleId) => !existingActiveRoleIds.has(roleId)) ||
            [...existingActiveRoleIds].some(
              (roleId) => !desiredRoleIds.has(roleId),
            )

          const invitationRoleIdsToSoftDelete = existingInvitationRoles
            .filter(
              (invitationRole) =>
                !invitationRole.deleted &&
                !desiredRoleIds.has(invitationRole.roleId),
            )
            .map((invitationRole) => invitationRole.id)

          if (invitationRoleIdsToSoftDelete.length > 0) {
            yield* db
              .update(schema.invitationRole)
              .set({
                _deleted: true,
                updatedAt: now,
                updatedBy,
              })
              .where(
                inArray(
                  schema.invitationRole.id,
                  invitationRoleIdsToSoftDelete,
                ),
              )
          }

          if (roleIds.length === 0) {
            // Empty role set is itself a grant change; invalidate any live link.
            if (rolesChanged) {
              yield* db
                .update(schema.invitation)
                .set({
                  ...clearRegistrationLinkColumns,
                  registrationLinkRevokedAt: now,
                  registrationLinkRevokedBy: updatedBy,
                  updatedAt: now,
                  updatedBy,
                })
                .where(
                  and(
                    eq(schema.invitation.id, invitationId),
                    eq(
                      schema.invitation.invitationStatus,
                      InvitationLifecycleStatus.Pending,
                    ),
                    eq(schema.invitation._deleted, false),
                    isNotNull(schema.invitation.registrationTokenHash),
                  ),
                )
            }
            return
          }

          const invitationRoleIdsToReactivate = roleIds.flatMap((roleId) => {
            const invitationRole = existingByRoleId.get(roleId)
            return invitationRole?.deleted ? [invitationRole.id] : []
          })

          if (invitationRoleIdsToReactivate.length > 0) {
            yield* db
              .update(schema.invitationRole)
              .set({
                _deleted: false,
                updatedAt: now,
                updatedBy,
              })
              .where(
                inArray(
                  schema.invitationRole.id,
                  invitationRoleIdsToReactivate,
                ),
              )
          }

          const roleIdsToInsert = roleIds.filter(
            (roleId) => !existingByRoleId.has(roleId),
          )

          if (roleIdsToInsert.length > 0) {
            yield* db.insert(schema.invitationRole).values(
              roleIdsToInsert.map((roleId) => ({
                invitationId,
                roleId,
                createdAt: now,
                updatedAt: now,
                createdBy: updatedBy,
                updatedBy,
                _deleted: false,
              })),
            )
          }

          // Role edits invalidate Registration Link authority even when email
          // is unchanged (and when this helper is called without a prior
          // updateInvitationDetails).
          if (rolesChanged) {
            yield* db
              .update(schema.invitation)
              .set({
                ...clearRegistrationLinkColumns,
                registrationLinkRevokedAt: now,
                registrationLinkRevokedBy: updatedBy,
                updatedAt: now,
                updatedBy,
              })
              .where(
                and(
                  eq(schema.invitation.id, invitationId),
                  eq(
                    schema.invitation.invitationStatus,
                    InvitationLifecycleStatus.Pending,
                  ),
                  eq(schema.invitation._deleted, false),
                  isNotNull(schema.invitation.registrationTokenHash),
                ),
              )
          }
        }),

      deleteInvitation: (invitationId: string, deletedBy: string) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now

          // Only pending invitations may be deleted through ordinary operations.
          // Clear Registration Link material so deleted access cannot be claimed.
          const updatedInvitations = yield* db
            .update(schema.invitation)
            .set({
              _deleted: true,
              invitationPendingEmail: null,
              ...clearRegistrationLinkColumns,
              registrationLinkRevokedAt: now,
              registrationLinkRevokedBy: deletedBy,
              updatedAt: now,
              updatedBy: deletedBy,
            })
            .where(
              and(
                eq(schema.invitation.id, invitationId),
                eq(
                  schema.invitation.invitationStatus,
                  InvitationLifecycleStatus.Pending,
                ),
                eq(schema.invitation._deleted, false),
              ),
            )
            .returning({ id: schema.invitation.id })

          if (updatedInvitations.length === 0) {
            return false
          }

          yield* db
            .update(schema.invitationRole)
            .set({
              _deleted: true,
              updatedAt: now,
              updatedBy: deletedBy,
            })
            .where(
              and(
                eq(schema.invitationRole.invitationId, invitationId),
                eq(schema.invitationRole._deleted, false),
              ),
            )

          return true
        }),

      storeRegistrationLink: (
        invitationId: string,
        input: RegistrationLinkPersistence,
      ) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now
          const expiresAt = DateTime.unsafeMake(input.expiresAt)

          const linkStatePredicate = input.requireActiveLink
            ? and(
                isNotNull(schema.invitation.registrationTokenHash),
                gt(schema.invitation.registrationLinkExpiresAt, now),
              )
            : or(
                isNull(schema.invitation.registrationTokenHash),
                lte(schema.invitation.registrationLinkExpiresAt, now),
              )

          const updated = yield* db
            .update(schema.invitation)
            .set({
              registrationTokenHash: input.tokenHash,
              registrationEncryptionVersion: input.encryptionVersion,
              registrationEncryptionNonce: input.nonce,
              registrationAuthenticationTag: input.authenticationTag,
              registrationEncryptedToken: input.ciphertext,
              registrationLinkExpiresAt: expiresAt,
              registrationLinkGeneratedAt: now,
              registrationLinkGeneratedBy: input.actor,
              registrationLinkRevealedAt: null,
              registrationLinkRevealedBy: null,
              registrationLinkRevokedAt: null,
              registrationLinkRevokedBy: null,
              registrationLinkGeneration: input.generation,
              updatedAt: now,
              updatedBy: input.actor,
            })
            .where(
              and(
                eq(schema.invitation.id, invitationId),
                eq(
                  schema.invitation.invitationStatus,
                  InvitationLifecycleStatus.Pending,
                ),
                eq(schema.invitation._deleted, false),
                // Optimistic concurrency: reject if another writer advanced generation.
                sql`coalesce(${schema.invitation.registrationLinkGeneration}, 0) = ${input.expectedPreviousGeneration}`,
                linkStatePredicate,
              ),
            )
            .returning({ id: schema.invitation.id })

          return updated.length > 0
        }),

      recordRegistrationLinkReveal: (
        invitationId: string,
        revealedBy: string,
        pin: {
          readonly tokenHash: string
          readonly generation: number
        },
      ) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now
          const updated = yield* db
            .update(schema.invitation)
            .set({
              registrationLinkRevealedAt: now,
              registrationLinkRevealedBy: revealedBy,
              updatedAt: now,
              updatedBy: revealedBy,
            })
            .where(
              and(
                eq(schema.invitation.id, invitationId),
                eq(
                  schema.invitation.invitationStatus,
                  InvitationLifecycleStatus.Pending,
                ),
                eq(schema.invitation._deleted, false),
                eq(schema.invitation.registrationTokenHash, pin.tokenHash),
                sql`coalesce(${schema.invitation.registrationLinkGeneration}, 0) = ${pin.generation}`,
                gt(schema.invitation.registrationLinkExpiresAt, now),
              ),
            )
            .returning({ id: schema.invitation.id })

          return updated.length > 0
        }),

      queryLiveRegistrationLink: (invitationId: string, now: Date) =>
        Effect.gen(function* () {
          const nowUtc = DateTime.unsafeMake(now)
          const results = yield* db
            .select({
              invitationId: schema.invitation.id,
              tokenHash: schema.invitation.registrationTokenHash,
              encryptionVersion:
                schema.invitation.registrationEncryptionVersion,
              nonce: schema.invitation.registrationEncryptionNonce,
              authenticationTag:
                schema.invitation.registrationAuthenticationTag,
              ciphertext: schema.invitation.registrationEncryptedToken,
              expiresAt: schema.invitation.registrationLinkExpiresAt,
              generation: schema.invitation.registrationLinkGeneration,
            })
            .from(schema.invitation)
            .where(
              and(
                eq(schema.invitation.id, invitationId),
                eq(
                  schema.invitation.invitationStatus,
                  InvitationLifecycleStatus.Pending,
                ),
                eq(schema.invitation._deleted, false),
                isNotNull(schema.invitation.registrationTokenHash),
                gt(schema.invitation.registrationLinkExpiresAt, nowUtc),
              ),
            )
            .limit(1)

          const row = results[0]
          if (
            !row?.tokenHash ||
            row.encryptionVersion === null ||
            !row.nonce ||
            !row.authenticationTag ||
            !row.ciphertext ||
            !row.expiresAt ||
            row.generation === null
          ) {
            return null
          }

          return {
            invitationId: row.invitationId,
            tokenHash: row.tokenHash,
            encryptionVersion: row.encryptionVersion,
            nonce: row.nonce,
            authenticationTag: row.authenticationTag,
            ciphertext: row.ciphertext,
            expiresAt: DateTime.toDateUtc(row.expiresAt),
            generation: row.generation,
          } satisfies LiveRegistrationLinkRow
        }),

      revokeRegistrationLink: (
        invitationId: string,
        revokedBy: string,
        pin?: {
          readonly tokenHash: string
          readonly generation: number
        },
      ) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now
          const pinPredicates = pin
            ? [
                eq(schema.invitation.registrationTokenHash, pin.tokenHash),
                sql`coalesce(${schema.invitation.registrationLinkGeneration}, 0) = ${pin.generation}`,
              ]
            : [isNotNull(schema.invitation.registrationTokenHash)]

          const updated = yield* db
            .update(schema.invitation)
            .set({
              ...clearRegistrationLinkColumns,
              registrationLinkRevokedAt: now,
              registrationLinkRevokedBy: revokedBy,
              updatedAt: now,
              updatedBy: revokedBy,
            })
            .where(
              and(
                eq(schema.invitation.id, invitationId),
                eq(
                  schema.invitation.invitationStatus,
                  InvitationLifecycleStatus.Pending,
                ),
                eq(schema.invitation._deleted, false),
                ...pinPredicates,
              ),
            )
            .returning({ id: schema.invitation.id })

          return updated.length > 0
        }),

      clearRegistrationLink: (invitationId: string, updatedBy: string) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now
          // Only rows with live/expired material are marked revoked.
          yield* db
            .update(schema.invitation)
            .set({
              ...clearRegistrationLinkColumns,
              registrationLinkRevokedAt: now,
              registrationLinkRevokedBy: updatedBy,
              updatedAt: now,
              updatedBy,
            })
            .where(
              and(
                eq(schema.invitation.id, invitationId),
                eq(schema.invitation._deleted, false),
                isNotNull(schema.invitation.registrationTokenHash),
              ),
            )
        }),

      isPasskeyProviderEnabled: () =>
        Effect.gen(function* () {
          const results = yield* db
            .select({ id: schema.oauthProvider.id })
            .from(schema.oauthProvider)
            .where(
              and(
                eq(schema.oauthProvider.providerName, "passkey"),
                eq(schema.oauthProvider._deleted, false),
              ),
            )
            .limit(1)
          return results.length > 0
        }),

      queryNotificationPreferences: (userId: string) =>
        Effect.gen(function* () {
          const results = yield* db
            .select({
              notificationPreference:
                schema.userSettings.notificationPreference,
            })
            .from(schema.userSettings)
            .where(
              and(
                eq(schema.userSettings.userId, userId),
                eq(schema.userSettings._deleted, false),
              ),
            )
            .limit(1)

          const r = results[0]

          if (!r?.notificationPreference) {
            return defaultNotificationPreferences
          }

          return parseNotificationPreferences(r.notificationPreference)
        }),

      updateNotificationPreferences: (
        userId: string,
        preferences: NotificationPreferences,
        updatedBy: string,
      ) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now

          yield* db
            .insert(schema.userSettings)
            .values({
              userId,
              notificationPreference:
                serializeNotificationPreferences(preferences),
              createdAt: now,
              updatedAt: now,
              updatedBy,
            })
            .onConflictDoUpdate({
              target: schema.userSettings.userId,
              targetWhere: sql`_deleted = 0`,
              set: {
                notificationPreference:
                  serializeNotificationPreferences(preferences),
                updatedAt: now,
                updatedBy,
              },
            })
        }),

      queryProviderUserByEmail: (email: string) =>
        Effect.gen(function* () {
          // Match auth Normalized Email lookup (case-insensitive).
          const normalizedEmail = email.trim().toLowerCase()
          const results = yield* db
            .select({
              id: schema.providerUser.id,
              email: schema.providerUser.email,
            })
            .from(schema.providerUser)
            .where(
              and(
                sql`lower(${schema.providerUser.email}) = ${normalizedEmail}`,
                eq(schema.providerUser._deleted, false),
              ),
            )
            .limit(1)

          return results[0] ?? null
        }),

      queryRoleByPath: (path: string) =>
        Effect.gen(function* () {
          const results = yield* db
            .select({
              id: schema.role.id,
              path: schema.role.path,
            })
            .from(schema.role)
            .where(
              and(eq(schema.role.path, path), eq(schema.role._deleted, false)),
            )
            .limit(1)

          return results[0] ?? null
        }),

      grantProviderUserRole: (
        providerUserId: string,
        roleId: string,
        grantedBy: string,
      ) =>
        Effect.gen(function* () {
          const existing = yield* db
            .select({
              id: schema.providerUserRole.id,
              deleted: schema.providerUserRole._deleted,
            })
            .from(schema.providerUserRole)
            .where(
              and(
                eq(schema.providerUserRole.providerUserId, providerUserId),
                eq(schema.providerUserRole.roleId, roleId),
              ),
            )
            .limit(1)

          const row = existing[0]

          if (row && !row.deleted) {
            return { alreadyHadRole: true } satisfies GrantRoleResult
          }

          const now = yield* DateTime.now

          if (row?.deleted) {
            yield* db
              .update(schema.providerUserRole)
              .set({
                _deleted: false,
                updatedAt: now,
                updatedBy: grantedBy,
              })
              .where(eq(schema.providerUserRole.id, row.id))

            return { alreadyHadRole: false } satisfies GrantRoleResult
          }

          const inserted = yield* db
            .insert(schema.providerUserRole)
            .values({
              providerUserId,
              roleId,
              createdAt: now,
              updatedAt: now,
              createdBy: grantedBy,
              updatedBy: grantedBy,
              _deleted: false,
            })
            .returning({ id: schema.providerUserRole.id })
            .pipe(
              Effect.catchAll((error) =>
                isActiveProviderUserRoleConflict(error)
                  ? Effect.succeed([] as Array<{ id: string }>)
                  : Effect.fail(error),
              ),
            )

          return {
            alreadyHadRole: inserted.length === 0,
          } satisfies GrantRoleResult
        }),
    }
  }),
)
