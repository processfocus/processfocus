import { and, eq, inArray, isNull, sql } from "drizzle-orm"
import { DateTime, Effect, Layer, Option } from "effect"
import * as schema from "@pf/drizzle-postgres"
import { permittedRole } from "@pf/drizzle-postgres"
import {
  type ProviderUserOrgUnitRow,
  ProviderUserQueries,
  type ProviderUserRow,
  type RoleRow,
  returnedRow,
} from "@pf/graphql-db-operations"
import { TypedPostgresDrizzle } from "@pf/service-drizzle-postgres"

/**
 * Maps database provider user result to ProviderUserRow
 */
const mapToProviderUserRow = (result: {
  id: string
  email: string
  name: string
  firstName: string
  lastName: string
  picture: string
  locale: string
  orgUnitId: string
  createdAt: DateTime.Utc
  updatedAt: DateTime.Utc
  createdBy: string | null
  updatedBy: string | null
  user: typeof schema.user.$inferSelect
  orgUnit: typeof schema.orgUnit.$inferSelect
}): ProviderUserRow => ({
  id: result.id,
  userId: result.user.id,
  email: result.email,
  name: result.name,
  firstName: result.firstName,
  lastName: result.lastName,
  picture: result.picture,
  locale: result.locale,
  provider: result.user.provider,
  sub: result.user.sub,
  orgUnitId: result.orgUnitId,
  orgUnitPath: result.orgUnit.path,
  createdAt: DateTime.toDateUtc(result.createdAt),
  updatedAt: DateTime.toDateUtc(result.updatedAt),
  createdBy: result.createdBy,
  updatedBy: result.updatedBy,
})

const escapeLikePattern = (value: string) => value.replace(/[\\%_]/g, "\\$&")

/**
 * PostgreSQL implementation of ProviderUserQueries service
 */
export const PostgresProviderUserQueriesLive = Layer.effect(
  ProviderUserQueries,
  Effect.gen(function* () {
    const db = yield* TypedPostgresDrizzle

    return {
      queryProviderUserByUserId: (id: string) =>
        Effect.gen(function* () {
          // Use findMany as there could be 0, and findFirst will
          // always return a mostly object if the provider user cannot be
          // found, and this will cause a crash in our date handling.
          const results = yield* db.query.providerUser.findMany({
            with: {
              user: true,
              orgUnit: true,
            },
            where: { userId: id },
          })
          if (results.length && results[0]) {
            return Option.some(mapToProviderUserRow(results[0]))
          } else {
            return Option.none()
          }
        }),

      queryProviderUserByProviderUserId: (id: string) =>
        Effect.gen(function* () {
          const results = yield* db.query.providerUser.findMany({
            with: {
              user: true,
              orgUnit: true,
            },
            where: { id },
          })
          if (results.length && results[0]) {
            return Option.some(mapToProviderUserRow(results[0]))
          } else {
            return Option.none()
          }
        }),

      queryProviderUserByEmail: (email: string) =>
        Effect.gen(function* () {
          // Match auth/settings Normalized Email lookup (case-insensitive).
          const normalizedEmail = email.trim().toLowerCase()
          const results = yield* db
            .select({
              providerUser: schema.providerUser,
              user: schema.user,
              orgUnit: schema.orgUnit,
            })
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
                sql`lower(${schema.providerUser.email}) = ${normalizedEmail}`,
                eq(schema.providerUser._deleted, false),
                eq(schema.user._deleted, false),
                eq(schema.orgUnit._deleted, false),
              ),
            )
            .limit(1)

          const row = results[0]
          if (!row) {
            return Option.none()
          }
          return Option.some(
            mapToProviderUserRow({
              ...row.providerUser,
              user: row.user,
              orgUnit: row.orgUnit,
            }),
          )
        }),

      queryProviderUsers: (
        filter: string,
        options: { offset: number; limit: number },
      ) =>
        Effect.gen(function* () {
          const trimmed = filter.trim()
          if (options.limit <= 0) return []

          const results = yield* db.query.providerUser.findMany({
            with: {
              user: true,
              orgUnit: true,
            },
            where:
              trimmed.length === 0
                ? { _deleted: false }
                : {
                    _deleted: false,
                    OR: [
                      {
                        RAW: (providerUser) =>
                          sql`${providerUser.name} ilike ${`%${escapeLikePattern(trimmed)}%`} escape ${"\\"}`,
                      },
                      {
                        RAW: (providerUser) =>
                          sql`${providerUser.email} ilike ${`%${escapeLikePattern(trimmed)}%`} escape ${"\\"}`,
                      },
                    ],
                  },
            orderBy: { name: "asc", email: "asc" },
            limit: options.limit,
            offset: options.offset,
          })

          return results.map(mapToProviderUserRow)
        }),

      queryAllRoles: () =>
        Effect.gen(function* () {
          const results = yield* db.query.role.findMany({
            where: { _deleted: false },
          })
          return results.map(
            (r): RoleRow => ({
              id: r.id,
              name: r.name,
              path: r.path,
            }),
          )
        }),

      queryProviderUserRoleIds: (providerUserId: string) =>
        Effect.gen(function* () {
          const results = yield* db.query.providerUserRole.findMany({
            where: { providerUserId, _deleted: false },
          })
          return results.map((r) => r.roleId)
        }),

      queryProviderUserRolePaths: (providerUserId: string) =>
        Effect.gen(function* () {
          const results = yield* db.query.providerUserRole.findMany({
            with: {
              role: true,
            },
            where: { providerUserId, _deleted: false },
          })
          return results.map((r) => r.role.path)
        }),

      queryProviderUserRolePathsByProviderUserIds: (
        providerUserIds: readonly string[],
      ) =>
        Effect.gen(function* () {
          if (providerUserIds.length === 0) return new Map()

          const results = yield* db.query.providerUserRole.findMany({
            with: {
              role: true,
            },
            where: {
              RAW: (providerUserRole) =>
                and(
                  inArray(providerUserRole.providerUserId, [
                    ...providerUserIds,
                  ]),
                  eq(providerUserRole._deleted, false),
                ) ?? sql`false`,
            },
          })
          const rolePaths = new Map<string, string[]>()
          for (const result of results) {
            const current = rolePaths.get(result.providerUserId) ?? []
            current.push(result.role.path)
            rolePaths.set(result.providerUserId, current)
          }
          return rolePaths
        }),

      replacePermittedRoles: (
        providerUserId: string,
        roleIds: readonly string[],
      ) =>
        Effect.gen(function* () {
          // Hard delete existing permitted roles for this provider user
          yield* db
            .delete(permittedRole)
            .where(eq(permittedRole.providerUserId, providerUserId))

          // Insert new permitted roles
          if (roleIds.length > 0) {
            yield* db.insert(permittedRole).values(
              roleIds.map((roleId) => ({
                providerUserId,
                roleId,
              })),
            )
          }
        }),

      queryRoleByPath: (path: string) =>
        Effect.gen(function* () {
          const results = yield* db.query.role.findMany({
            where: { path, _deleted: false },
          })
          if (results.length && results[0]) {
            const r = results[0]
            return Option.some<RoleRow>({
              id: r.id,
              name: r.name,
              path: r.path,
            })
          }
          return Option.none()
        }),

      addPermittedRole: (providerUserId: string, roleId: string) =>
        db
          .insert(permittedRole)
          .values({
            providerUserId,
            roleId,
          })
          .onConflictDoUpdate({
            target: [permittedRole.providerUserId, permittedRole.roleId],
            targetWhere: eq(permittedRole._deleted, false),
            set: { updatedAt: sql`now()` },
          }),

      findInvitationRoleIds: (email: string) =>
        Effect.gen(function* () {
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
        }),

      findRootOrgUnit: () =>
        Effect.gen(function* () {
          const results = yield* db
            .select({ id: schema.orgUnit.id, path: schema.orgUnit.path })
            .from(schema.orgUnit)
            .where(
              and(
                isNull(schema.orgUnit.parentOrgUnitId),
                eq(schema.orgUnit._deleted, false),
              ),
            )
            .limit(1)

          const result = results[0]
          return result
            ? Option.some<ProviderUserOrgUnitRow>({
                id: result.id,
                path: result.path,
              })
            : Option.none()
        }),

      createProviderUserFromInvitation: (input: {
        email: string
        orgUnitId: string
      }) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now
          const normalizedEmail = input.email.toLowerCase()
          const userResult = yield* db
            .insert(schema.user)
            .values({
              provider: "m2m",
              sub: `m2m:${normalizedEmail}`,
              lastLoggedIn: now,
            })
            .returning()
          const user = yield* returnedRow(userResult)

          const providerUserResult = yield* db
            .insert(schema.providerUser)
            .values({
              userId: user.id,
              email: normalizedEmail,
              name: normalizedEmail.split("@")[0] ?? normalizedEmail,
              firstName: "",
              lastName: "",
              picture: "",
              locale: "",
              orgUnitId: input.orgUnitId,
            })
            .returning()

          const providerUser = yield* returnedRow(providerUserResult)

          return { userId: user.id, providerUserId: providerUser.id }
        }),

      acceptPendingInvitationForProviderUser: (input) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now
          const normalizedEmail = input.email.toLowerCase()
          const accepted = yield* db
            .update(schema.invitation)
            .set({
              invitationStatus: "accepted",
              invitationPendingEmail: null,
              invitationAcceptedAt: now,
              invitationAcceptedByProvider: input.provider,
              invitationAcceptedBySubject: input.subject,
              acceptedByProviderUserId: input.providerUserId,
              registrationTokenHash: null,
              registrationEncryptionVersion: null,
              registrationEncryptionNonce: null,
              registrationAuthenticationTag: null,
              registrationEncryptedToken: null,
              registrationLinkExpiresAt: null,
              registrationLinkGeneration: sql`coalesce(${schema.invitation.registrationLinkGeneration}, 0) + 1`,
              updatedAt: now,
              updatedBy: "SYSTEM",
            })
            .where(
              and(
                eq(schema.invitation.invitationPendingEmail, normalizedEmail),
                eq(schema.invitation.invitationStatus, "pending"),
                eq(schema.invitation._deleted, false),
              ),
            )
            .returning({ id: schema.invitation.id })

          return accepted.length > 0
        }),

      assignProviderUserRoles: (
        providerUserId: string,
        roleIds: readonly string[],
      ) =>
        Effect.gen(function* () {
          if (roleIds.length === 0) return
          yield* db
            .insert(schema.providerUserRole)
            .values(roleIds.map((roleId) => ({ providerUserId, roleId })))
        }),
    }
  }),
)
