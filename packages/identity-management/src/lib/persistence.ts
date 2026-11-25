import type { Effect } from "effect"
import type { SqlError } from "effect/sql/SqlError"

/** Durable Invitation outcomes; soft deletion is not a stored status. */
export const InvitationLifecycleStatus = {
  Pending: "pending",
  Accepted: "accepted",
  LegacyClosed: "legacy_closed",
} as const
export type InvitationLifecycleStatus =
  (typeof InvitationLifecycleStatus)[keyof typeof InvitationLifecycleStatus]

export const InvitationSource = {
  Model: "model",
  Dashboard: "dashboard",
  Cli: "cli",
  Process: "process",
  Legacy: "legacy",
} as const
export type InvitationSource =
  (typeof InvitationSource)[keyof typeof InvitationSource]

/** Derived link state; never contains bearer secrets. */
export const RegistrationLinkStatus = {
  NotGenerated: "not_generated",
  Active: "active",
  Expired: "expired",
  Revoked: "revoked",
} as const
export type RegistrationLinkStatus =
  (typeof RegistrationLinkStatus)[keyof typeof RegistrationLinkStatus]

export interface SettingsInvitationRow {
  readonly id: string
  readonly email: string
  readonly status: InvitationLifecycleStatus
  readonly source: InvitationSource
  readonly roles: readonly {
    readonly id: string
    readonly name: string
    readonly path: string
  }[]
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
  /** Internal Registration Session binding; not exposed in bulk responses. */
  readonly registrationLinkGeneration: number
}

/** Encrypted material; never return through bulk GraphQL responses. */
export interface RegistrationLinkPersistence {
  readonly tokenHash: string
  readonly encryptionVersion: number
  readonly nonce: string
  readonly authenticationTag: string
  readonly ciphertext: string
  readonly expiresAt: Date
  readonly generation: number
  /** CAS against the previous generation (null treated as zero). */
  readonly expectedPreviousGeneration: number
  /** Rotate requires a live link; generate requires no live link. */
  readonly requireActiveLink: boolean
  readonly actor: string
}

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

/** Existing operations supply these queries inside the caller's transaction. */
export interface RegistrationLinkPersistenceQueries {
  readonly queryInvitationDetail: (
    invitationId: string,
  ) => Effect.Effect<SettingsInvitationRow | null, SqlError>
  readonly queryInvitationByNormalizedEmail: (
    email: string,
  ) => Effect.Effect<SettingsInvitationRow | null, SqlError>
  readonly isPasskeyProviderEnabled: () => Effect.Effect<boolean, SqlError>
  readonly queryLiveRegistrationLink: (
    invitationId: string,
    now: Date,
  ) => Effect.Effect<LiveRegistrationLinkRow | null, SqlError>
  readonly storeRegistrationLink: (
    invitationId: string,
    input: RegistrationLinkPersistence,
  ) => Effect.Effect<boolean, SqlError>
  /** Pin prevents clearing a concurrent generation. */
  readonly revokeRegistrationLink: (
    invitationId: string,
    actor: string,
    pin?: { readonly tokenHash: string; readonly generation: number },
  ) => Effect.Effect<boolean, SqlError>
}

export interface RoleManagementPersistence {
  readonly queryProviderUserByEmail: (
    email: string,
  ) => Effect.Effect<{ readonly id: string } | null, SqlError>
  readonly queryRoleByPath: (
    path: string,
  ) => Effect.Effect<{ readonly id: string } | null, SqlError>
  readonly grantProviderUserRole: (
    providerUserId: string,
    roleId: string,
    grantedBy: string,
  ) => Effect.Effect<{ readonly alreadyHadRole: boolean }, SqlError>
}
