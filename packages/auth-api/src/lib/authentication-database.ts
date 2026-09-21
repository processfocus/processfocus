import { Context, Data, type DateTime, Effect, type Option } from "effect"
import type { OAuthProviderConfig } from "@pf/auth-config"

/**
 * Expected failure for AuthenticationDatabase read operations.
 * Message is a stable boundary description; do not put SQL text in `message`.
 * Underlying driver/SQL detail stays in `cause` for logs only.
 */
export class DatabaseQueryError extends Data.TaggedError(
  "@pf/auth-api/DatabaseQueryError",
)<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Expected failure for AuthenticationDatabase write operations.
 * Message is a stable boundary description; do not put SQL text in `message`.
 * Underlying driver/SQL detail stays in `cause` for logs only.
 */
export class DatabaseWriteError extends Data.TaggedError(
  "@pf/auth-api/DatabaseWriteError",
)<{
  readonly message: string
  readonly cause?: unknown
}> {}

/** Union of AuthenticationDatabase boundary failures. */
export type AuthenticationDatabaseError =
  | DatabaseQueryError
  | DatabaseWriteError

/**
 * Map any failure into a DatabaseQueryError with a stable boundary message.
 * Used by AuthenticationDatabase implementations (sqlite/postgres).
 */
export const mapQueryError =
  (message: string) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, DatabaseQueryError, R> =>
    effect.pipe(
      Effect.mapError((cause) => new DatabaseQueryError({ message, cause })),
    )

/**
 * Map any failure into a DatabaseWriteError with a stable boundary message.
 * Used by AuthenticationDatabase implementations (sqlite/postgres).
 */
export const mapWriteError =
  (message: string) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, DatabaseWriteError, R> =>
    effect.pipe(
      Effect.mapError((cause) => new DatabaseWriteError({ message, cause })),
    )

export interface OrgUnitRecord {
  readonly id: string
  readonly name: string
  readonly orgUnitLevel: string
  readonly path: string
  readonly parentOrgUnitId: string | null
}

export interface ProviderUserRecord {
  /**
   * User id, not provider user id.
   */
  readonly id: string
  readonly email: string
  readonly locale: string
  readonly picture: string | null
  readonly provider: string
  readonly sub: string
  readonly orgUnitId: string
  readonly orgUnitPath: string
}

export interface CreateProviderUserInput {
  readonly email: string
  readonly name: string
  readonly firstName: string
  readonly lastName: string
  readonly picture: string
  readonly locale: string
  readonly provider: string
  readonly sub: string
  readonly orgUnitId: string
}

export interface PasskeyCredentialRecord
  extends Pick<ProviderUserRecord, "provider" | "sub"> {
  readonly userId: string
  readonly email: string
  readonly credentialId: string
  readonly publicKey: string
  readonly counter: number
  readonly transports?: readonly string[]
}

export interface CreatePasskeyCredentialInput {
  readonly userId: string
  readonly credentialId: string
  readonly publicKey: string
  readonly counter: number
  readonly transports?: readonly string[]
  readonly name?: string
}

/** Active Passkey metadata for authenticated self-service listing and enrollment. */
export interface PasskeyManagementCredential {
  readonly id: string
  readonly name: string | null
  readonly createdAt: DateTime.Utc
  readonly lastUsedAt: DateTime.Utc | null
  readonly credentialId: string
  readonly transports?: readonly string[]
}

/**
 * Outcome of an atomic last-credential-preserving Passkey removal.
 * `last_credential` means the row is still the account's only active Passkey.
 */
export type RemovePasskeyCredentialResult =
  | "removed"
  | "not_found"
  | "last_credential"

/**
 * Result of exchanging a live Registration Link for a Registration Session.
 * Raw session bearer is returned once; only its hash is persisted.
 */
export interface RegistrationSessionExchangeResult {
  readonly email: string
  readonly sessionBearer: string
  readonly expiresAt: DateTime.Utc
  readonly invitationId: string
  readonly linkGeneration: number
}

/**
 * Resolved Registration Session context for Invitation passkey registration.
 */
export interface InvitationRegistrationSessionContext {
  readonly email: string
  readonly invitationId: string
  readonly linkGeneration: number
  readonly sessionTokenHash: string
  readonly sessionId: string
}

export type OAuthStorageValue = Record<string, unknown>

export interface OAuthProviderRecord {
  readonly name: string
  readonly config: OAuthProviderConfig
}

export interface OAuthClientRecord {
  readonly clientId: string
  readonly secretHash: string
  readonly audience: string
}

export class AuthenticationDatabase extends Context.Tag(
  "@pf/auth-api/AuthenticationDatabase",
)<
  AuthenticationDatabase,
  {
    readonly findRootOrgUnit: () => Effect.Effect<
      Option.Option<OrgUnitRecord>,
      DatabaseQueryError
    >
    readonly findProviderUserByProviderSub: (
      provider: string,
      sub: string,
    ) => Effect.Effect<Option.Option<ProviderUserRecord>, DatabaseQueryError>
    readonly findProviderUserByEmail: (
      email: string,
    ) => Effect.Effect<Option.Option<ProviderUserRecord>, DatabaseQueryError>
    readonly findProviderUserById: (
      id: string,
    ) => Effect.Effect<Option.Option<ProviderUserRecord>, DatabaseQueryError>
    readonly findProviderUserByUserId: (
      userId: string,
    ) => Effect.Effect<Option.Option<ProviderUserRecord>, DatabaseQueryError>
    /** Closed, non-deleted invitation belonging to this existing account. */
    readonly findRecoveryInvitation: (
      userId: string,
      email: string,
    ) => Effect.Effect<Option.Option<string>, DatabaseQueryError>
    readonly createProviderUser: (
      input: CreateProviderUserInput,
    ) => Effect.Effect<ProviderUserRecord, DatabaseWriteError>
    readonly findPasskeyCredentialById: (
      credentialId: string,
    ) => Effect.Effect<
      Option.Option<PasskeyCredentialRecord>,
      DatabaseQueryError
    >
    readonly createPasskeyCredential: (
      input: CreatePasskeyCredentialInput,
    ) => Effect.Effect<void, DatabaseWriteError>
    readonly listPasskeyCredentialsForUser: (
      userId: string,
    ) => Effect.Effect<
      readonly PasskeyManagementCredential[],
      DatabaseQueryError
    >
    readonly renamePasskeyCredential: (input: {
      readonly userId: string
      readonly id: string
      readonly name: string
    }) => Effect.Effect<boolean, DatabaseWriteError>
    readonly removePasskeyCredential: (input: {
      readonly userId: string
      readonly id: string
    }) => Effect.Effect<RemovePasskeyCredentialResult, DatabaseWriteError>
    readonly advancePasskeyCredentialCounter: (
      credentialId: string,
      expectedCounter: number,
      newCounter: number,
      lastUsedAt?: DateTime.Utc,
    ) => Effect.Effect<boolean, DatabaseWriteError>
    readonly updateLastLoggedIn: (
      userId: string,
      lastLoggedIn: DateTime.Utc,
    ) => Effect.Effect<void, DatabaseWriteError>
    /**
     * Updates provider user profile picture.
     */
    readonly updateProviderUserProfilePicture: (
      userId: string,
      picture: string,
    ) => Effect.Effect<void, DatabaseWriteError>
    readonly findAllOAuthProviders: () => Effect.Effect<
      OAuthProviderRecord[],
      DatabaseQueryError
    >
    /**
     * Find a single OAuth provider by name.
     * Used for lazy loading providers on first request.
     */
    readonly findOAuthProviderByName: (
      name: string,
    ) => Effect.Effect<Option.Option<OAuthProviderRecord>, DatabaseQueryError>
    /**
     * Find all role paths for a provider user by their user ID.
     * Joins through provider user table to find roles.
     * Returns role paths (not role names or IDs) for use in Cedar policies.
     */
    readonly findProviderUserRoles: (
      userId: string,
    ) => Effect.Effect<string[], DatabaseQueryError>
    /**
     * Find invitation role IDs for a pending Invitation by Normalized Email.
     * Used during provider user creation to auto-assign roles from invitations.
     * Returns role database PKs (not paths). Only active roles on a non-deleted
     * pending Invitation are returned.
     */
    readonly findInvitationRoleIds: (
      email: string,
    ) => Effect.Effect<string[], DatabaseQueryError>
    /**
     * Whether a non-deleted pending Invitation exists for the Normalized Email.
     * Used by Passkey Open Registration to refuse emails that must use a
     * Registration Link instead.
     */
    readonly hasPendingInvitation: (
      email: string,
    ) => Effect.Effect<boolean, DatabaseQueryError>
    /**
     * Conditionally accept a still-pending Invitation after human/passkey
     * bootstrap. `userId` is the backing User id (looked up to provider-user PK).
     * Clears live Registration Link authority and soft-deletes Registration
     * Sessions for the accepted Invitation.
     * Returns true when this call performed the acceptance transition.
     */
    readonly acceptPendingInvitationForUser: (input: {
      readonly email: string
      /**
       * Backing User id of the newly created Provider User (not provider-user PK).
       */
      readonly userId: string
      readonly provider: string
      readonly subject: string
      readonly acceptedAt: DateTime.Utc
      /**
       * When set, pins acceptance to one Invitation row and link generation so
       * concurrent registration ceremonies cannot double-accept.
       */
      readonly invitationPin?: {
        readonly invitationId: string
        readonly linkGeneration: number
      }
    }) => Effect.Effect<boolean, DatabaseWriteError>
    /**
     * Exchange a live Registration Link token for a ten-minute Registration
     * Session. Validates token generation, link expiry, pending Invitation,
     * active roles, unowned email, and passkey enablement. Returns none for
     * every invalid state (generic public error).
     */
    readonly exchangeRegistrationLink: (
      rawToken: string,
    ) => Effect.Effect<
      Option.Option<RegistrationSessionExchangeResult>,
      DatabaseWriteError
    >
    /**
     * Revalidate a Registration Session bearer for options, verification, and
     * commit. Does not re-check link expiry (session lifetime applies) but
     * fails on rotation, revocation, edit, deletion, acceptance, role loss,
     * email ownership, or provider disablement.
     */
    readonly resolveInvitationRegistrationSession: (
      sessionBearer: string,
    ) => Effect.Effect<
      Option.Option<InvitationRegistrationSessionContext>,
      DatabaseQueryError
    >
    /**
     * Soft-delete every Registration Session for an Invitation (acceptance,
     * explicit cleanup). Idempotent.
     */
    readonly deleteRegistrationSessionsForInvitation: (
      invitationId: string,
    ) => Effect.Effect<void, DatabaseWriteError>
    /**
     * Assign roles to a provider user by creating provider_user_role records.
     * @param providerUserId - The provider user database PK
     * @param roleIds - Array of role database PKs to assign
     */
    readonly assignProviderUserRoles: (
      providerUserId: string,
      roleIds: string[],
    ) => Effect.Effect<void, DatabaseWriteError>
    /**
     * Find all configured OAuth clients for M2M authentication.
     * Returns client IDs and their secrets.
     */
    readonly findAllOAuthClients: () => Effect.Effect<
      OAuthClientRecord[],
      DatabaseQueryError
    >
    /**
     * Find an OAuth client by its client ID.
     * Used for dynamic client lookup at request time.
     */
    readonly findOAuthClientById: (
      clientId: string,
    ) => Effect.Effect<Option.Option<OAuthClientRecord>, DatabaseQueryError>
    /**
     * Validate that all provided role paths exist in the database.
     * Returns the paths that were found (for comparison with requested paths).
     */
    readonly validateRolePaths: (
      paths: readonly string[],
    ) => Effect.Effect<string[], DatabaseQueryError>
    /**
     * Find or create an M2M (machine-to-machine) user for client_credentials authentication.
     * Uses provider "client_credentials" and the client ID as sub.
     * Creates the user if it doesn't exist, updates last_logged_in if requested.
     * Returns the database user ID for use in JWT tokens.
     */
    readonly upsertM2MUser: (
      clientId: string,
      lastLoggedIn: DateTime.Utc,
      options?: { readonly updateLastLoggedIn?: boolean },
    ) => Effect.Effect<string, DatabaseWriteError>
    /**
     * Find permitted roles with their org unit info for a provider user by their user ID.
     * Queries the permitted_role table which is populated by Cedar authorization checks.
     * Returns role paths with org unit info for use in role switching.
     * When switching to a permitted role, the session's org unit context is updated
     * to match the role's org unit.
     */
    readonly findPermittedRolesWithOrgUnit: (
      userId: string,
    ) => Effect.Effect<
      Array<{ rolePath: string; orgUnitId: string; orgUnitPath: string }>,
      DatabaseQueryError
    >
    /**
     * Find an org unit by its path.
     * Used for M2M provider user token generation with org: scope override.
     */
    readonly findOrgUnitByPath: (
      path: string,
    ) => Effect.Effect<Option.Option<OrgUnitRecord>, DatabaseQueryError>
    /**
     * Validate that all provided role paths exist in the database.
     * Returns the roles with their org unit info for use in token generation.
     */
    readonly validateRolePathsWithOrgUnit: (
      paths: readonly string[],
    ) => Effect.Effect<
      Array<{ rolePath: string; orgUnitId: string; orgUnitPath: string }>,
      DatabaseQueryError
    >
    /**
     * Find the permitted role for a confidential client (M2M).
     * Looks up the oauth_client by clientId, then joins permitted_client_role
     * with role and org_unit tables.
     * Returns role path, org unit info, and updatedAt timestamp.
     * Returns Option.none() if no permitted role exists for this client/role combination.
     */
    readonly findPermittedClientRole: (
      clientId: string,
      rolePath: string,
    ) => Effect.Effect<
      Option.Option<{
        rolePath: string
        orgUnitId: string
        orgUnitPath: string
        updatedAt: DateTime.Utc
      }>,
      DatabaseQueryError
    >
    /**
     * Find role IDs by their paths.
     * Used for OU-based role assignment where Google OU paths map to role paths.
     * Returns role database PKs for paths that exist and are not deleted.
     */
    readonly findRoleIdsByPaths: (
      paths: readonly string[],
    ) => Effect.Effect<string[], DatabaseQueryError>
    /**
     * Find the permitted provider user email for a confidential client (M2M).
     * Looks up the oauth_client by clientId, then joins permitted_client_email.
     * Returns the email and updatedAt timestamp.
     * Returns Option.none() if no permission exists for this client/email combination.
     */
    readonly findPermittedClientEmail: (
      clientId: string,
      email: string,
    ) => Effect.Effect<
      Option.Option<{ email: string; updatedAt: DateTime.Utc }>,
      DatabaseQueryError
    >
  }
>() {}
