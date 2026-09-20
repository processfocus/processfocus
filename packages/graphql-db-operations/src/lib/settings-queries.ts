import type { SqlError } from "@effect/sql/SqlError"
import { Context, type Effect } from "effect"

/**
 * Database row type for user with optional provider user data
 */
export interface SettingsUserRow {
  readonly id: string
  readonly provider: string
  readonly sub: string
  readonly lastLoggedIn: Date
  readonly isProviderUser: boolean
  readonly providerUserName: string | null
  readonly providerUserEmail: string | null
}

/**
 * Database row type for OAuth provider
 */
export interface SettingsOAuthProviderRow {
  readonly id: string
  readonly providerName: string
}

/**
 * Database row type for user detail with provider user data
 */
export interface SettingsUserDetailRow {
  readonly id: string
  readonly provider: string
  readonly sub: string
  readonly lastLoggedIn: Date
  readonly providerUser: SettingsProviderUserRow | null
}

/**
 * Database row type for provider user in settings context
 */
export interface SettingsProviderUserRow {
  readonly id: string
  readonly email: string
  readonly name: string
  readonly firstName: string
  readonly lastName: string
  readonly roleIds: readonly string[]
  readonly notificationPreferences: NotificationPreferences
}

/**
 * Notification preferences structure for todo assignment events.
 */
export interface NotificationPreferences {
  readonly notifications: {
    readonly todoAssignment: {
      readonly email: boolean
    }
    readonly executionFailure: {
      readonly email: boolean
    }
  }
}

export const defaultNotificationPreferences: NotificationPreferences = {
  notifications: {
    todoAssignment: {
      email: false,
    },
    executionFailure: {
      email: false,
    },
  },
}

export interface GrantRoleResult {
  readonly alreadyHadRole: boolean
}

export interface ProviderUserLookupRow {
  readonly id: string
  readonly email: string
}

export interface RoleLookupRow {
  readonly id: string
  readonly path: string
}

export const parseNotificationPreferences = (
  stored: unknown,
): NotificationPreferences => {
  if (!stored || typeof stored !== "object") {
    return defaultNotificationPreferences
  }

  const record = stored as Record<string, unknown>
  const notifications =
    (record["notifications"] as Record<string, unknown>) ?? {}
  const todoAssignment =
    (notifications["todoAssignment"] as Record<string, unknown>) ?? {}
  const executionFailure =
    (notifications["executionFailure"] as Record<string, unknown>) ?? {}

  return {
    notifications: {
      todoAssignment: {
        email:
          typeof todoAssignment["email"] === "boolean"
            ? todoAssignment["email"]
            : false,
      },
      executionFailure: {
        email:
          typeof executionFailure["email"] === "boolean"
            ? executionFailure["email"]
            : false,
      },
    },
  }
}

export const serializeNotificationPreferences = (
  preferences: NotificationPreferences,
) => ({
  notifications: {
    todoAssignment: {
      email: preferences.notifications.todoAssignment.email,
    },
    executionFailure: {
      email: preferences.notifications.executionFailure.email,
    },
  },
})

/**
 * Database row type for role (simplified)
 */
export interface SettingsRoleRow {
  readonly id: string
  readonly name: string
  readonly path: string
}

/**
 * Invitation lifecycle status stored in pf_invitation.invitation_status.
 * Soft-delete (`_deleted`) is the deleted outcome and is not a stored status.
 */
export const InvitationLifecycleStatus = {
  Pending: "pending",
  Accepted: "accepted",
  LegacyClosed: "legacy_closed",
} as const

export type InvitationLifecycleStatus =
  (typeof InvitationLifecycleStatus)[keyof typeof InvitationLifecycleStatus]

/**
 * Invitation write-boundary source stored in pf_invitation.invitation_source.
 */
export const InvitationSource = {
  Model: "model",
  Dashboard: "dashboard",
  Process: "process",
  Legacy: "legacy",
} as const

export type InvitationSource =
  (typeof InvitationSource)[keyof typeof InvitationSource]

/**
 * Derived Registration Link status for Invited Users dashboard rows.
 * Never includes bearer secrets.
 */
export const RegistrationLinkStatus = {
  NotGenerated: "not_generated",
  Active: "active",
  Expired: "expired",
  Revoked: "revoked",
} as const

export type RegistrationLinkStatus =
  (typeof RegistrationLinkStatus)[keyof typeof RegistrationLinkStatus]

/**
 * Database row type for invitation with roles and lifecycle metadata.
 */
export interface SettingsInvitationRow {
  readonly id: string
  readonly email: string
  readonly status: InvitationLifecycleStatus
  readonly source: InvitationSource
  readonly roles: readonly SettingsRoleRow[]
  readonly acceptedAt: Date | null
  readonly acceptedByProvider: string | null
  readonly acceptedBySubject: string | null
  readonly acceptedByProviderUserId: string | null
  readonly legacyClosedAt: Date | null
  readonly legacyClosureReason: string | null
  readonly registrationLinkStatus: RegistrationLinkStatus
  readonly registrationLinkExpiresAt: Date | null
  readonly registrationLinkGeneratedAt: Date | null
  readonly registrationLinkGeneratedBy: string | null
  readonly registrationLinkRevealedAt: Date | null
  readonly registrationLinkRevealedBy: string | null
  readonly registrationLinkRevokedAt: Date | null
  readonly registrationLinkRevokedBy: string | null
  /**
   * Internal generation counter for Registration Session binding.
   * Not exposed on the bulk GraphQL invitation type.
   */
  readonly registrationLinkGeneration: number
}

/**
 * Encrypted Registration Link material persisted on a pending Invitation.
 * Callers must never return these fields through bulk GraphQL responses.
 */
export interface RegistrationLinkPersistence {
  readonly tokenHash: string
  readonly encryptionVersion: number
  readonly nonce: string
  readonly authenticationTag: string
  readonly ciphertext: string
  readonly expiresAt: Date
  /** New generation value written on success. */
  readonly generation: number
  /**
   * Optimistic concurrency: row must still have this previous generation
   * (null column treated as 0).
   */
  readonly expectedPreviousGeneration: number
  /**
   * When true (rotate), require a currently live unexpired token.
   * When false (generate), require no live unexpired token.
   */
  readonly requireActiveLink: boolean
  readonly actor: string
}

/**
 * Live Registration Link envelope fields needed for authorised reveal.
 */
export interface LiveRegistrationLinkRow {
  readonly invitationId: string
  readonly tokenHash: string
  readonly encryptionVersion: number
  readonly nonce: string
  readonly authenticationTag: string
  readonly ciphertext: string
  readonly expiresAt: Date
  readonly generation: number
}

/**
 * Input for updating provider user app-managed settings.
 */
export interface UpdateProviderUserInput {
  readonly roleIds: readonly string[]
}

/**
 * Input for creating an invitation.
 */
export interface CreateInvitationInput {
  readonly invitationId: string
  readonly email: string
  readonly source: InvitationSource
  readonly createdBy: string
  readonly updatedBy: string
}

/**
 * Input for updating an invitation's email address.
 */
export interface UpdateInvitationInput {
  readonly email: string
  readonly updatedBy: string
}

/**
 * Paginated result with total count
 */
export interface PaginatedResult<T> {
  readonly items: readonly T[]
  readonly totalCount: number
}

/**
 * Service providing settings query operations for GraphQL resolvers
 */
export class SettingsQueries extends Context.Tag(
  "@pf/graphql-db-operations/SettingsQueries",
)<
  SettingsQueries,
  {
    /**
     * Query paginated users with provider user status
     */
    readonly queryAllUsers: (
      page: number,
      limit: number,
    ) => Effect.Effect<PaginatedResult<SettingsUserRow>, SqlError>

    /**
     * Query paginated OAuth providers
     */
    readonly queryAllOAuthProviders: (
      page: number,
      limit: number,
    ) => Effect.Effect<PaginatedResult<SettingsOAuthProviderRow>, SqlError>

    /**
     * Query paginated invitations with their assigned roles.
     * Defaults to pending when status is omitted.
     */
    readonly queryAllInvitations: (
      page: number,
      limit: number,
      status?: InvitationLifecycleStatus,
    ) => Effect.Effect<PaginatedResult<SettingsInvitationRow>, SqlError>

    /**
     * Query invitation detail by invitation ID.
     */
    readonly queryInvitationDetail: (
      invitationId: string,
    ) => Effect.Effect<SettingsInvitationRow | null, SqlError>

    /**
     * Query the pending invitation for a normalized email address, if any.
     */
    readonly queryPendingInvitationByEmail: (
      email: string,
    ) => Effect.Effect<SettingsInvitationRow | null, SqlError>

    /**
     * Query the invitation for a Normalized Email. Prefers a pending
     * Invitation when one exists; otherwise returns the latest non-deleted
     * Invitation for that email (accepted or legacy-closed history).
     */
    readonly queryInvitationByNormalizedEmail: (
      email: string,
    ) => Effect.Effect<SettingsInvitationRow | null, SqlError>

    /**
     * Query user detail with provider user data by user ID
     */
    readonly queryUserDetail: (
      userId: string,
    ) => Effect.Effect<SettingsUserDetailRow | null, SqlError>

    /**
     * Query provider user detail by provider user ID
     */
    readonly queryProviderUserDetail: (
      providerUserId: string,
    ) => Effect.Effect<SettingsProviderUserRow | null, SqlError>

    /**
     * Query all roles in the system (non-paginated, for internal validation)
     */
    readonly queryAllRoles: () => Effect.Effect<
      readonly SettingsRoleRow[],
      SqlError
    >

    /**
     * Query a specific set of roles by ID.
     */
    readonly queryRolesByIds: (
      roleIds: readonly string[],
    ) => Effect.Effect<readonly SettingsRoleRow[], SqlError>

    /**
     * Query paginated roles in the system
     */
    readonly queryPaginatedRoles: (
      page: number,
      limit: number,
    ) => Effect.Effect<PaginatedResult<SettingsRoleRow>, SqlError>

    /**
     * Query role IDs assigned to a provider user
     */
    readonly queryProviderUserRoleIds: (
      providerUserId: string,
    ) => Effect.Effect<readonly string[], SqlError>

    /**
     * Replace all role assignments for a provider user
     * Deletes existing and inserts new assignments
     */
    readonly replaceProviderUserRoles: (
      providerUserId: string,
      roleIds: readonly string[],
    ) => Effect.Effect<void, SqlError>

    /**
     * Create a new invitation.
     * Returns the database-generated primary key.
     */
    readonly createInvitation: (
      input: CreateInvitationInput,
    ) => Effect.Effect<string, SqlError>

    /**
     * Update an invitation email address.
     */
    readonly updateInvitationDetails: (
      invitationId: string,
      input: UpdateInvitationInput,
    ) => Effect.Effect<boolean, SqlError>

    /**
     * Replace all role assignments for an invitation.
     */
    readonly replaceInvitationRoles: (
      invitationId: string,
      roleIds: readonly string[],
      updatedBy: string,
    ) => Effect.Effect<void, SqlError>

    /**
     * Soft-delete an invitation and remove its role assignments.
     */
    readonly deleteInvitation: (
      invitationId: string,
      deletedBy: string,
    ) => Effect.Effect<boolean, SqlError>

    /**
     * Persist a newly generated or rotated Registration Link on a pending
     * Invitation. Returns false when the invitation is not pending.
     */
    readonly storeRegistrationLink: (
      invitationId: string,
      input: RegistrationLinkPersistence,
    ) => Effect.Effect<boolean, SqlError>

    /**
     * Record an authorised reveal without changing expiry or token material.
     * Pins tokenHash/generation so concurrent rotate/generate cannot stamp
     * reveal metadata on a different link generation.
     */
    readonly recordRegistrationLinkReveal: (
      invitationId: string,
      revealedBy: string,
      pin: {
        readonly tokenHash: string
        readonly generation: number
      },
    ) => Effect.Effect<boolean, SqlError>

    /**
     * Load live Registration Link envelope fields for authorised reveal.
     * Returns null when no live (unexpired, unrevoked) link exists.
     */
    readonly queryLiveRegistrationLink: (
      invitationId: string,
      now: Date,
    ) => Effect.Effect<LiveRegistrationLinkRow | null, SqlError>

    /**
     * Revoke the live Registration Link while preserving the pending Invitation.
     * Optional pin restricts revoke to a specific tokenHash/generation so a
     * concurrent rotate/generate is not cleared by a stale writer.
     */
    readonly revokeRegistrationLink: (
      invitationId: string,
      revokedBy: string,
      pin?: {
        readonly tokenHash: string
        readonly generation: number
      },
    ) => Effect.Effect<boolean, SqlError>

    /**
     * Clear Registration Link authority (used on pending edit/delete).
     * Sets last-revocation metadata so the row shows as revoked rather than
     * never-generated, matching explicit revoke semantics for dashboard display.
     */
    readonly clearRegistrationLink: (
      invitationId: string,
      updatedBy: string,
    ) => Effect.Effect<void, SqlError>

    /**
     * Whether the passkey OAuth provider is currently enabled (not soft-deleted).
     */
    readonly isPasskeyProviderEnabled: () => Effect.Effect<boolean, SqlError>

    /**
     * Query notification preferences for a user.
     * Returns default-off preferences (email: false) if no settings exist.
     */
    readonly queryNotificationPreferences: (
      userId: string,
    ) => Effect.Effect<NotificationPreferences, SqlError>

    /**
     * Update notification preferences for a user.
     * Creates or updates the user settings record.
     */
    readonly updateNotificationPreferences: (
      userId: string,
      preferences: NotificationPreferences,
      updatedBy: string,
    ) => Effect.Effect<void, SqlError>

    /**
     * Look up a provider user by email address.
     * Returns null when no matching active provider user exists.
     */
    readonly queryProviderUserByEmail: (
      email: string,
    ) => Effect.Effect<ProviderUserLookupRow | null, SqlError>

    /**
     * Look up a role by its path.
     * Returns null when no matching active role exists.
     */
    readonly queryRoleByPath: (
      path: string,
    ) => Effect.Effect<RoleLookupRow | null, SqlError>

    /**
     * Idempotent grant of a role to a provider user.
     *
     * If the role is already assigned (active), returns { alreadyHadRole: true }
     * without mutating audit fields.
     *
     * If the assignment exists but is soft-deleted, it is reactivated with
     * the new audit fields and { alreadyHadRole: false } is returned.
     *
     * If no assignment row exists at all, a new row is inserted with the
     * given grantedBy audit actor and { alreadyHadRole: false } is returned.
     */
    readonly grantProviderUserRole: (
      providerUserId: string,
      roleId: string,
      grantedBy: string,
    ) => Effect.Effect<GrantRoleResult, SqlError>
  }
>() {}
