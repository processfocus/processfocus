import { Data, DateTime, Effect, Option } from "effect"
import { causeChainIncludes } from "@pf/db-info"
import type {
  PasskeyAuthenticationProperties,
  PasskeyRegistrationProperties,
} from "@pf/openauth"
import {
  AuthenticationDatabase,
  type CreateProviderUserInput,
} from "./authentication-database.js"
import { resolveInviteOnlyForProvider } from "./invite-only.js"
import { withNonCriticalRetry } from "./non-critical-retry.js"
import {
  consumePasskeyRecovery,
  hashPasskeyRecoveryBearer,
  resolvePasskeyRecoverySession,
} from "./passkey-recovery.js"
import { getPasskeyUserHandle } from "./passkey-user-handle.js"

class RootOrgUnitNotFoundError extends Data.TaggedError(
  "@pf/RootOrgUnitNotFoundError",
)<{ readonly message: string }> {}

/**
 * Public denial copy for Open Registration eligibility failures.
 * Must not disclose whether denial is due to invite-only mode, an existing
 * Provider User, or a pending Invitation.
 */
export const OPEN_REGISTRATION_DENIED_MESSAGE =
  "Registration is not available for this email"

/**
 * Public denial copy for Invitation Registration Link / Session failures.
 * Shared for unknown, malformed, expired, revoked, rotated, deleted, accepted,
 * legacy-closed, role-less, existing-user, disabled-provider, and invalid-session.
 */
export const INVITATION_REGISTRATION_INVALID_MESSAGE =
  "This registration link is no longer valid. Ask an administrator for a new Registration Link."

/** Registration Session lifetime after successful token exchange. */
export const REGISTRATION_SESSION_TTL_MINUTES = 10

/**
 * Open Registration eligibility failure (invite-only, owned email, or pending
 * Invitation). Surfaces one generic public message.
 */
export class PasskeyOpenRegistrationDeniedError extends Data.TaggedError(
  "@pf/PasskeyOpenRegistrationDeniedError",
)<{ readonly email: string }> {}

/**
 * Invitation Registration Link/Session failure. Surfaces one generic public
 * message and must not disclose which validation gate failed.
 */
export class PasskeyInvitationRegistrationDeniedError extends Data.TaggedError(
  "@pf/PasskeyInvitationRegistrationDeniedError",
)<{ readonly reason: string }> {}

export class PasskeyIdentityNotFoundError extends Data.TaggedError(
  "@pf/PasskeyIdentityNotFoundError",
)<{ readonly userHandle: string }> {}

export class PasskeyCounterError extends Data.TaggedError(
  "@pf/PasskeyCounterError",
)<{ readonly credentialId: string }> {}

export class PasskeyCredentialAlreadyOwnedError extends Data.TaggedError(
  "@pf/PasskeyCredentialAlreadyOwnedError",
)<{ readonly credentialId: string }> {}

/**
 * Authenticated self-service enrollment is unavailable for this account.
 * Distinct from Open Registration and Invitation denial copy.
 */
export class PasskeyManagementDeniedError extends Data.TaggedError(
  "@pf/PasskeyManagementDeniedError",
)<{ readonly reason: string }> {}

/**
 * Detect unique-constraint races from driver/SQL error text across SQLite/Turso
 * and Postgres wrappers. Matchers should stay tied to known index/column names.
 * Uses the shared cause-chain walker so nested DatabaseWriteError.cause is
 * searched with cycle protection.
 */
const isUniqueConstraintViolation = (
  cause: unknown,
  matchers: readonly RegExp[],
): boolean =>
  causeChainIncludes(
    cause,
    (message) =>
      /unique/i.test(message) &&
      matchers.some((matcher) => matcher.test(message)),
  )

/** Map concurrent email ownership races to the generic Open Registration denial. */
const isProviderUserEmailUniqueViolation = (cause: unknown): boolean =>
  isUniqueConstraintViolation(cause, [
    /pf_provider_user\.email/i,
    /pf_provider_user_emailidx/i,
    /provider_user.*email/i,
  ])

/** Map concurrent credential-id races to a typed already-owned error. */
const isPasskeyCredentialUniqueViolation = (cause: unknown): boolean =>
  isUniqueConstraintViolation(cause, [
    /passkey_credential_id/i,
    /pf_passkey_credential/i,
  ])

const withRoles = Effect.fn("passkey.withRoles")(function* (userId: string) {
  const db = yield* AuthenticationDatabase
  const roles = yield* db.findProviderUserRoles(userId)
  const providerUser = yield* db.findProviderUserByUserId(userId)
  if (Option.isNone(providerUser)) {
    return yield* new PasskeyIdentityNotFoundError({ userHandle: userId })
  }
  return { ...providerUser.value, roles }
})

/**
 * Authorise Passkey Open Registration for a Normalized Email.
 *
 * Available only when passkey `inviteOnly` is disabled, the email is not owned
 * by any Provider User, and there is no pending Invitation. Does not inspect
 * or claim Invitation roles.
 */
export const authorizePasskeyOpenRegistration = (email: string) =>
  Effect.gen(function* () {
    const db = yield* AuthenticationDatabase
    const inviteOnly = yield* resolveInviteOnlyForProvider("passkey")
    if (inviteOnly) {
      return yield* new PasskeyOpenRegistrationDeniedError({ email })
    }

    const existingOwner = yield* db.findProviderUserByEmail(email)
    if (Option.isSome(existingOwner)) {
      return yield* new PasskeyOpenRegistrationDeniedError({ email })
    }

    const hasPendingInvitation = yield* db.hasPendingInvitation(email)
    if (hasPendingInvitation) {
      return yield* new PasskeyOpenRegistrationDeniedError({ email })
    }

    return { allowed: true as const }
  })

/**
 * Revalidate a Registration Session for Invitation passkey registration.
 */
export const authorizePasskeyInvitationRegistration = (sessionBearer: string) =>
  Effect.gen(function* () {
    const db = yield* AuthenticationDatabase
    const context =
      yield* db.resolveInvitationRegistrationSession(sessionBearer)
    if (Option.isNone(context)) {
      return yield* new PasskeyInvitationRegistrationDeniedError({
        reason: "invalid_session",
      })
    }
    return context.value
  })

/**
 * Create a Provider User via Passkey Open Registration or Invitation
 * Registration Session acceptance.
 *
 * Open Registration assigns no roles and never claims a pending Invitation.
 * Invitation registration atomically assigns roles, accepts the Invitation,
 * clears its Registration Link, and deletes its Registration Sessions.
 */
export const registerProviderUserByPasskey = (
  value: PasskeyRegistrationProperties,
) =>
  Effect.gen(function* () {
    if (value.registrationKind === "recovery") {
      const db = yield* AuthenticationDatabase
      const session = yield* resolvePasskeyRecoverySession(value.sessionBearer)
      if (
        Option.isNone(session) ||
        session.value.recoveryId !== value.recoveryId ||
        session.value.userId !== value.userId ||
        session.value.userHandle !== value.userHandle ||
        session.value.email !== value.email ||
        hashPasskeyRecoveryBearer(value.sessionBearer) !==
          value.sessionTokenHash
      ) {
        return yield* new PasskeyInvitationRegistrationDeniedError({
          reason: "invalid_recovery_session",
        })
      }
      if (!(yield* consumePasskeyRecovery(session.value))) {
        return yield* new PasskeyInvitationRegistrationDeniedError({
          reason: "recovery_consumed",
        })
      }
      yield* db
        .createPasskeyCredential({
          userId: session.value.userId,
          credentialId: value.credential.id,
          publicKey: value.credential.publicKey,
          counter: value.credential.counter,
          ...(value.credential.transports && {
            transports: value.credential.transports,
          }),
        })
        .pipe(
          Effect.mapError((cause) =>
            isPasskeyCredentialUniqueViolation(cause)
              ? new PasskeyCredentialAlreadyOwnedError({
                  credentialId: value.credential.id,
                })
              : cause,
          ),
        )
      return yield* withRoles(session.value.userId)
    }
    if (value.registrationKind === "invitation") {
      return yield* registerProviderUserByInvitationPasskey(value)
    }

    // registrationKind is narrowed to "open"
    yield* authorizePasskeyOpenRegistration(value.email)

    const db = yield* AuthenticationDatabase
    const existingCredential = yield* db.findPasskeyCredentialById(
      value.credential.id,
    )
    if (Option.isSome(existingCredential)) {
      return yield* new PasskeyCredentialAlreadyOwnedError({
        credentialId: value.credential.id,
      })
    }

    const rootOrgUnit = yield* db.findRootOrgUnit()
    if (Option.isNone(rootOrgUnit)) {
      return yield* new RootOrgUnitNotFoundError({
        message: "No root organization unit found in database",
      })
    }

    // Revalidate eligibility immediately before writes so a concurrent
    // invitation or Provider User created during the ceremony wins.
    yield* authorizePasskeyOpenRegistration(value.email)

    const providerUserData: CreateProviderUserInput = {
      email: value.email,
      name: value.email,
      firstName: "",
      lastName: "",
      picture: "",
      locale: "",
      provider: "passkey",
      sub: value.userHandle,
      orgUnitId: rootOrgUnit.value.id,
    }
    const providerUser = yield* db
      .createProviderUser(providerUserData)
      .pipe(
        Effect.mapError((cause) =>
          isProviderUserEmailUniqueViolation(cause)
            ? new PasskeyOpenRegistrationDeniedError({ email: value.email })
            : cause,
        ),
      )
    yield* db
      .createPasskeyCredential({
        userId: providerUser.id,
        credentialId: value.credential.id,
        publicKey: value.credential.publicKey,
        counter: value.credential.counter,
        ...(value.credential.transports && {
          transports: value.credential.transports,
        }),
      })
      .pipe(
        Effect.mapError((cause) =>
          isPasskeyCredentialUniqueViolation(cause)
            ? new PasskeyCredentialAlreadyOwnedError({
                credentialId: value.credential.id,
              })
            : cause,
        ),
      )

    // Final in-transaction guard: a pending Invitation that committed after the
    // pre-write check must still abort so Open Registration cannot leave a
    // role-less user beside an open Invitation grant.
    const hasPendingInvitation = yield* db.hasPendingInvitation(value.email)
    if (hasPendingInvitation) {
      return yield* new PasskeyOpenRegistrationDeniedError({
        email: value.email,
      })
    }

    // Open Registration never assigns Invitation roles or fabricates acceptance.
    return yield* withRoles(providerUser.id)
  })

/**
 * Invitation Registration Session path: create Provider User, credential,
 * assign Invitation roles, accept with generation pin, clear link, delete
 * sessions — all in the caller's transaction.
 */
const registerProviderUserByInvitationPasskey = (
  value: Extract<
    PasskeyRegistrationProperties,
    { registrationKind: "invitation" }
  >,
) =>
  Effect.gen(function* () {
    const db = yield* AuthenticationDatabase

    // Revalidate session and invitation predicates before any write.
    const session = yield* db.resolveInvitationRegistrationSession(
      value.sessionBearer,
    )
    if (Option.isNone(session)) {
      return yield* new PasskeyInvitationRegistrationDeniedError({
        reason: "invalid_session",
      })
    }
    const context = session.value
    if (
      context.email !== value.email ||
      context.invitationId !== value.invitationId ||
      context.linkGeneration !== value.linkGeneration ||
      context.sessionTokenHash !== value.sessionTokenHash
    ) {
      return yield* new PasskeyInvitationRegistrationDeniedError({
        reason: "session_mismatch",
      })
    }

    const existingCredential = yield* db.findPasskeyCredentialById(
      value.credential.id,
    )
    if (Option.isSome(existingCredential)) {
      return yield* new PasskeyCredentialAlreadyOwnedError({
        credentialId: value.credential.id,
      })
    }

    const rootOrgUnit = yield* db.findRootOrgUnit()
    if (Option.isNone(rootOrgUnit)) {
      return yield* new RootOrgUnitNotFoundError({
        message: "No root organization unit found in database",
      })
    }

    // Revalidate immediately before writes (concurrent OAuth/passkey race).
    const revalidated = yield* db.resolveInvitationRegistrationSession(
      value.sessionBearer,
    )
    if (Option.isNone(revalidated)) {
      return yield* new PasskeyInvitationRegistrationDeniedError({
        reason: "invalid_session",
      })
    }

    const roleIds = yield* db.findInvitationRoleIds(context.email)
    if (roleIds.length === 0) {
      return yield* new PasskeyInvitationRegistrationDeniedError({
        reason: "role_less",
      })
    }

    const providerUserData: CreateProviderUserInput = {
      email: context.email,
      name: context.email,
      firstName: "",
      lastName: "",
      picture: "",
      locale: "",
      provider: "passkey",
      sub: value.userHandle,
      orgUnitId: rootOrgUnit.value.id,
    }
    const providerUser = yield* db.createProviderUser(providerUserData).pipe(
      Effect.mapError((cause) =>
        isProviderUserEmailUniqueViolation(cause)
          ? new PasskeyInvitationRegistrationDeniedError({
              reason: "email_owned",
            })
          : cause,
      ),
    )

    yield* db
      .createPasskeyCredential({
        userId: providerUser.id,
        credentialId: value.credential.id,
        publicKey: value.credential.publicKey,
        counter: value.credential.counter,
        ...(value.credential.transports && {
          transports: value.credential.transports,
        }),
      })
      .pipe(
        Effect.mapError((cause) =>
          isPasskeyCredentialUniqueViolation(cause)
            ? new PasskeyCredentialAlreadyOwnedError({
                credentialId: value.credential.id,
              })
            : cause,
        ),
      )

    yield* db.assignProviderUserRoles(providerUser.id, roleIds)

    const acceptedAt = yield* DateTime.now
    const accepted = yield* db.acceptPendingInvitationForUser({
      email: context.email,
      userId: providerUser.id,
      provider: "passkey",
      subject: value.userHandle,
      acceptedAt,
      invitationPin: {
        invitationId: context.invitationId,
        linkGeneration: context.linkGeneration,
      },
    })
    if (!accepted) {
      // Concurrent acceptance won; roll back entire transaction.
      return yield* new PasskeyInvitationRegistrationDeniedError({
        reason: "acceptance_race",
      })
    }

    return yield* withRoles(providerUser.id)
  })

/**
 * Add a named Passkey to an existing account. Preserves the backing User,
 * Provider User, original provider, roles, and Invitation history. Does not
 * reopen Invitations or consume Registration Links.
 */
export const registerAdditionalPasskeyForAccount = (input: {
  readonly userId: string
  readonly userHandle: string
  readonly name: string
  readonly credential: {
    readonly id: string
    readonly publicKey: string
    readonly counter: number
    readonly transports?: readonly string[]
  }
}) =>
  Effect.gen(function* () {
    const db = yield* AuthenticationDatabase
    const providerUser = yield* db.findProviderUserByUserId(input.userId)
    if (Option.isNone(providerUser)) {
      return yield* new PasskeyIdentityNotFoundError({
        userHandle: input.userHandle,
      })
    }
    if (
      getPasskeyUserHandle({
        ...providerUser.value,
        userId: providerUser.value.id,
      }) !== input.userHandle
    ) {
      return yield* new PasskeyManagementDeniedError({
        reason: "user_handle_mismatch",
      })
    }
    const existing = yield* db.listPasskeyCredentialsForUser(input.userId)
    if (existing.length === 0) {
      return yield* new PasskeyManagementDeniedError({
        reason: "no_existing_passkey",
      })
    }
    const duplicate = yield* db.findPasskeyCredentialById(input.credential.id)
    if (Option.isSome(duplicate)) {
      return yield* new PasskeyCredentialAlreadyOwnedError({
        credentialId: input.credential.id,
      })
    }
    yield* db
      .createPasskeyCredential({
        userId: input.userId,
        credentialId: input.credential.id,
        publicKey: input.credential.publicKey,
        counter: input.credential.counter,
        name: input.name,
        ...(input.credential.transports && {
          transports: input.credential.transports,
        }),
      })
      .pipe(
        Effect.mapError((cause) =>
          isPasskeyCredentialUniqueViolation(cause)
            ? new PasskeyCredentialAlreadyOwnedError({
                credentialId: input.credential.id,
              })
            : cause,
        ),
      )
    return yield* withRoles(input.userId)
  })

export const authenticateProviderUserByPasskey = (
  value: PasskeyAuthenticationProperties,
) =>
  Effect.gen(function* () {
    const db = yield* AuthenticationDatabase
    const credential = yield* db.findPasskeyCredentialById(value.credentialId)
    if (
      Option.isNone(credential) ||
      getPasskeyUserHandle(credential.value) !== value.userHandle
    ) {
      return yield* new PasskeyIdentityNotFoundError({
        userHandle: value.userHandle,
      })
    }
    const providerUser = yield* db.findProviderUserByUserId(
      credential.value.userId,
    )
    if (Option.isNone(providerUser)) {
      return yield* new PasskeyIdentityNotFoundError({
        userHandle: value.userHandle,
      })
    }

    const now = yield* DateTime.now
    if (
      (value.previousCounter === 0 && value.newCounter === 0) ||
      value.newCounter > value.previousCounter
    ) {
      const recorded = yield* db.advancePasskeyCredentialCounter(
        value.credentialId,
        value.previousCounter,
        value.newCounter,
        now,
      )
      if (!recorded) {
        return yield* new PasskeyCounterError({
          credentialId: value.credentialId,
        })
      }
    } else {
      return yield* new PasskeyCounterError({
        credentialId: value.credentialId,
      })
    }

    yield* withNonCriticalRetry(
      db.updateLastLoggedIn(providerUser.value.id, now),
      "updateLastLoggedIn",
    )
    return yield* withRoles(providerUser.value.id)
  })
