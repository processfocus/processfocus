import type { SqlError } from "@effect/sql/SqlError"
import { DateTime, Effect, Either } from "effect"
import {
  REGISTRATION_LINK_TTL_DAYS,
  buildRegistrationLinkUrl,
  generateRegistrationLinkMaterial,
} from "@pf/graphql-schema"
import {
  InvitationLifecycleStatus,
  RegistrationLinkStatus,
  type SettingsInvitationRow,
  SettingsQueries,
} from "./settings-queries"

export const INVITATION_NOT_FOUND_MESSAGE = "Invitation not found"

export const IMMUTABLE_INVITATION_MESSAGE =
  "This invitation can no longer be changed. Create a new invitation if you need to grant roles again."

export const NO_ACTIVE_ROLES_MESSAGE =
  "Assign at least one role before generating a registration link."

export const PASSKEY_PROVIDER_DISABLED_MESSAGE =
  "Registration links are unavailable while the passkey provider is disabled."

export const ACTIVE_REGISTRATION_LINK_EXISTS_MESSAGE =
  "An active registration link already exists. Reveal or rotate it instead."

export const ACTIVE_REGISTRATION_LINK_REQUIRES_ROTATE_MESSAGE =
  "An active registration link already exists. Pass --rotate to replace it."

export const NO_ACTIVE_REGISTRATION_LINK_MESSAGE =
  "There is no active registration link."

export const REGISTRATION_LINK_CONFLICT_MESSAGE =
  "Could not update the registration link. Refresh and try again."

export const TRUSTED_FRONTEND_ORIGIN_NOT_CONFIGURED_MESSAGE =
  "Trusted frontend origin is not configured."

export const REGISTRATION_LINK_KEY_FAILURE_MESSAGE =
  "Registration link encryption is not configured correctly."

export const REGISTRATION_LINK_CRYPTO_FAILURE_MESSAGE =
  "Registration link could not be processed. Refresh and try again."

export const mapRegistrationLinkCryptoError = (error: {
  readonly message: string
}): string => {
  const message = error.message
  if (
    message.includes("INVITATION_REGISTRATION_ENCRYPTION_KEY") ||
    message.includes("not configured")
  ) {
    return REGISTRATION_LINK_KEY_FAILURE_MESSAGE
  }
  return REGISTRATION_LINK_CRYPTO_FAILURE_MESSAGE
}

export type IssueRegistrationLinkSuccess = {
  readonly ok: true
  readonly invitation: SettingsInvitationRow
  readonly email: string
  readonly registrationLinkUrl: string
  readonly expiresAt: Date
}

export type IssueRegistrationLinkFailure = {
  readonly ok: false
  readonly error: string
}

export type IssueRegistrationLinkResult =
  | IssueRegistrationLinkSuccess
  | IssueRegistrationLinkFailure

/** Whole-second expiry so AES-GCM AAD survives julianday datetime round-trips. */
export const registrationLinkExpiryDate = (from: DateTime.Utc): Date => {
  const raw = DateTime.toDateUtc(
    DateTime.add(from, { days: REGISTRATION_LINK_TTL_DAYS }),
  )
  return new Date(Math.round(raw.getTime() / 1000) * 1000)
}

const failure = (error: string): IssueRegistrationLinkFailure => ({
  ok: false,
  error,
})

/**
 * After generate/rotate store, re-assert the invitation still has active roles
 * and that the just-written token pin is still live.
 * Closes races where concurrent role wipe or concurrent rotate would leave an
 * ACTIVE link on a role-less invitation or return a dead bearer URL.
 */
const ensureStoredRegistrationLinkHasRoles = (
  settingsQueries: typeof SettingsQueries.Service,
  invitationId: string,
  actor: string,
  pin: {
    readonly tokenHash: string
    readonly generation: number
  },
) =>
  Effect.gen(function* () {
    const invitation =
      yield* settingsQueries.queryInvitationDetail(invitationId)
    if (!invitation) {
      return failure(INVITATION_NOT_FOUND_MESSAGE)
    }
    if (invitation.roles.length === 0) {
      // Only clear the generation this mutation wrote; never a concurrent link.
      yield* settingsQueries.revokeRegistrationLink(invitationId, actor, pin)
      return failure(NO_ACTIVE_ROLES_MESSAGE)
    }

    const now = yield* DateTime.now
    const live = yield* settingsQueries.queryLiveRegistrationLink(
      invitationId,
      DateTime.toDateUtc(now),
    )
    if (
      !live ||
      live.tokenHash !== pin.tokenHash ||
      live.generation !== pin.generation
    ) {
      return failure(REGISTRATION_LINK_CONFLICT_MESSAGE)
    }

    return {
      ok: true as const,
      invitation,
    }
  })

export const issueRegistrationLink = (input: {
  readonly invitation: SettingsInvitationRow
  readonly rotate: boolean
  readonly actor: string
  readonly organisationScope: string
  readonly frontendOrigin: string
  readonly secret?: string
}): Effect.Effect<IssueRegistrationLinkResult, SqlError, SettingsQueries> =>
  Effect.gen(function* () {
    const settingsQueries = yield* SettingsQueries
    const invitation = input.invitation

    if (invitation.status !== InvitationLifecycleStatus.Pending) {
      return failure(IMMUTABLE_INVITATION_MESSAGE)
    }
    if (invitation.roles.length === 0) {
      return failure(NO_ACTIVE_ROLES_MESSAGE)
    }

    if (
      !input.rotate &&
      invitation.registrationLinkStatus === RegistrationLinkStatus.Active
    ) {
      return failure(ACTIVE_REGISTRATION_LINK_EXISTS_MESSAGE)
    }

    const passkeyEnabled = yield* settingsQueries.isPasskeyProviderEnabled()
    if (!passkeyEnabled) {
      return failure(PASSKEY_PROVIDER_DISABLED_MESSAGE)
    }

    const now = yield* DateTime.now
    let expectedPreviousGeneration = invitation.registrationLinkGeneration
    if (input.rotate) {
      const live = yield* settingsQueries.queryLiveRegistrationLink(
        invitation.id,
        DateTime.toDateUtc(now),
      )
      if (
        !live &&
        invitation.registrationLinkStatus !== RegistrationLinkStatus.Expired
      ) {
        return failure(NO_ACTIVE_REGISTRATION_LINK_MESSAGE)
      }
      expectedPreviousGeneration =
        live?.generation ?? expectedPreviousGeneration
    }

    const frontendOrigin = input.frontendOrigin.replace(/\/$/, "")
    if (!frontendOrigin) {
      return failure(TRUSTED_FRONTEND_ORIGIN_NOT_CONFIGURED_MESSAGE)
    }

    const expiresAt = registrationLinkExpiryDate(now)
    const materialResult = yield* generateRegistrationLinkMaterial({
      organisationScope: input.organisationScope,
      invitationId: invitation.id,
      expiresAtUnixMs: expiresAt.getTime(),
      ...(input.secret === undefined ? {} : { secret: input.secret }),
    }).pipe(Effect.either)

    return yield* Either.match(materialResult, {
      onLeft: (error) =>
        Effect.succeed(failure(mapRegistrationLinkCryptoError(error))),
      onRight: (material) =>
        Effect.gen(function* () {
          const generation = expectedPreviousGeneration + 1
          const stored = yield* settingsQueries.storeRegistrationLink(
            invitation.id,
            {
              tokenHash: material.tokenHash,
              encryptionVersion: material.envelope.encryptionVersion,
              nonce: material.envelope.nonce,
              authenticationTag: material.envelope.authenticationTag,
              ciphertext: material.envelope.ciphertext,
              expiresAt,
              generation,
              expectedPreviousGeneration,
              requireActiveLink:
                input.rotate &&
                invitation.registrationLinkStatus ===
                  RegistrationLinkStatus.Active,
              actor: input.actor,
            },
          )
          if (!stored) {
            return failure(REGISTRATION_LINK_CONFLICT_MESSAGE)
          }

          const ensured = yield* ensureStoredRegistrationLinkHasRoles(
            settingsQueries,
            invitation.id,
            input.actor,
            {
              tokenHash: material.tokenHash,
              generation,
            },
          )
          if (!ensured.ok) {
            return ensured
          }

          return {
            ok: true as const,
            invitation: ensured.invitation,
            email: ensured.invitation.email,
            registrationLinkUrl: buildRegistrationLinkUrl(
              frontendOrigin,
              material.rawToken,
            ),
            expiresAt,
          }
        }),
    })
  })

export const issueRegistrationLinkForEmail = (input: {
  readonly email: string
  readonly rotate: boolean
  readonly actor: string
  readonly organisationScope: string
  readonly frontendOrigin: string
  readonly secret?: string
}): Effect.Effect<IssueRegistrationLinkResult, SqlError, SettingsQueries> =>
  Effect.gen(function* () {
    const settingsQueries = yield* SettingsQueries
    const email = input.email.trim().toLowerCase()
    const invitation =
      yield* settingsQueries.queryInvitationByNormalizedEmail(email)
    if (!invitation) {
      return failure(INVITATION_NOT_FOUND_MESSAGE)
    }

    return yield* issueRegistrationLink({
      invitation,
      rotate: input.rotate,
      actor: input.actor,
      organisationScope: input.organisationScope,
      frontendOrigin: input.frontendOrigin,
      ...(input.secret === undefined ? {} : { secret: input.secret }),
    })
  })
