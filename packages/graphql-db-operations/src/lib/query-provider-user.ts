import type { SqlError } from "@effect/sql/SqlError"
import { Context, type Effect, type Option } from "effect"

/**
 * Database row type for provider user
 */
export interface ProviderUserRow {
  readonly id: string
  readonly userId: string
  readonly email: string
  readonly name: string
  readonly firstName: string
  readonly lastName: string
  readonly picture: string
  readonly locale: string
  readonly provider: string
  readonly sub: string
  readonly orgUnitId: string
  readonly orgUnitPath: string
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly createdBy: string | null
  readonly updatedBy: string | null
}

/**
 * Database row type for role (simplified for queries)
 */
export interface RoleRow {
  readonly id: string
  readonly name: string
  readonly path: string
}

/**
 * Database row type for org unit (minimal for provider user queries)
 */
export interface ProviderUserOrgUnitRow {
  readonly id: string
  readonly path: string
}

/**
 * Service providing provider user query operations for GraphQL resolvers
 */
export class ProviderUserQueries extends Context.Tag(
  "@pf/graphql-db-operations/ProviderUserQueries",
)<
  ProviderUserQueries,
  {
    /**
     * Find provider user by user ID
     */
    readonly queryProviderUserByUserId: (
      id: string,
    ) => Effect.Effect<Option.Option<ProviderUserRow>, SqlError>

    /**
     * Find provider user by the internal provider_user.id column.
     */
    readonly queryProviderUserByProviderUserId: (
      id: string,
    ) => Effect.Effect<Option.Option<ProviderUserRow>, SqlError>

    /**
     * Find provider user by email
     */
    readonly queryProviderUserByEmail: (
      email: string,
    ) => Effect.Effect<Option.Option<ProviderUserRow>, SqlError>

    /**
     * Search provider users by display name or email.
     */
    readonly queryProviderUsers: (
      filter: string,
      options: { offset: number; limit: number },
    ) => Effect.Effect<readonly ProviderUserRow[], SqlError>

    /**
     * Get all roles in the system
     */
    readonly queryAllRoles: () => Effect.Effect<readonly RoleRow[], SqlError>

    /**
     * Get provider user's assigned role IDs (from provider_user_role table)
     */
    readonly queryProviderUserRoleIds: (
      providerUserId: string,
    ) => Effect.Effect<readonly string[], SqlError>

    /**
     * Get provider user's assigned role paths (from provider_user_role joined with role)
     */
    readonly queryProviderUserRolePaths: (
      providerUserId: string,
    ) => Effect.Effect<readonly string[], SqlError>

    /**
     * Get role paths for multiple provider users, keyed by provider user id.
     */
    readonly queryProviderUserRolePathsByProviderUserIds: (
      providerUserIds: readonly string[],
    ) => Effect.Effect<ReadonlyMap<string, readonly string[]>, SqlError>

    /**
     * Replace all permitted roles for a provider user
     * Deletes existing permitted_role entries and inserts new ones
     */
    readonly replacePermittedRoles: (
      providerUserId: string,
      roleIds: readonly string[],
    ) => Effect.Effect<void, SqlError>

    /**
     * Query a role by its path
     */
    readonly queryRoleByPath: (
      path: string,
    ) => Effect.Effect<Option.Option<RoleRow>, SqlError>

    /**
     * Set a single permitted role for a provider user (for role switching)
     * Clears existing permitted roles and sets just this one
     */
    readonly addPermittedRole: (
      providerUserId: string,
      roleId: string,
    ) => Effect.Effect<void, SqlError>

    /**
     * Find role IDs from invitation for a given email
     */
    readonly findInvitationRoleIds: (
      email: string,
    ) => Effect.Effect<readonly string[], SqlError>

    /**
     * Find the root org unit (parentOrgUnitId is null)
     */
    readonly findRootOrgUnit: () => Effect.Effect<
      Option.Option<ProviderUserOrgUnitRow>,
      SqlError
    >

    /**
     * Create provider user and user records from invitation
     */
    readonly createProviderUserFromInvitation: (input: {
      email: string
      orgUnitId: string
    }) => Effect.Effect<{ userId: string; providerUserId: string }, SqlError>

    /**
     * Conditionally accept a still-pending Invitation after M2M bootstrap.
     * `providerUserId` is the provider-user primary key (not the backing User id).
     * Returns true when this call performed the acceptance transition.
     */
    readonly acceptPendingInvitationForProviderUser: (input: {
      readonly email: string
      readonly providerUserId: string
      readonly provider: string
      readonly subject: string
    }) => Effect.Effect<boolean, SqlError>

    /**
     * Assign roles to a provider user (provider_user_role table)
     */
    readonly assignProviderUserRoles: (
      providerUserId: string,
      roleIds: readonly string[],
    ) => Effect.Effect<void, SqlError>
  }
>() {}
