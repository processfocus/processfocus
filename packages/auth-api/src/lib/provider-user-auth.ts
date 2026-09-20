import { Data, DateTime, Effect, Either, Option, Schema } from "effect"
import { GoogleOAuthProviderConfigSchema } from "@pf/auth-config"
import type {
  ProviderSubjectIdentity,
  VerifiedHumanIdentity,
} from "@pf/openauth/provider/provider"
import {
  AuthenticationDatabase,
  type CreateProviderUserInput,
  type ProviderUserRecord,
} from "./authentication-database.js"
import { fetchUserOrgUnitPath } from "./google-directory.js"
import { resolveInviteOnlyForProvider } from "./invite-only.js"
import { withNonCriticalRetry } from "./non-critical-retry.js"

/**
 * Error thrown when no root organization unit is found in the database
 */
export class RootOrgUnitNotFoundError extends Data.TaggedError(
  "@pf/RootOrgUnitNotFoundError",
)<{
  readonly message: string
}> {}

export class InviteRequiredError extends Data.TaggedError(
  "@pf/InviteRequiredError",
)<{
  readonly email: string
}> {}

export class DummyProviderUserNotFoundError extends Data.TaggedError(
  "@pf/DummyProviderUserNotFoundError",
)<{
  readonly email: string
}> {}

export class VerifiedEmailRequiredError extends Data.TaggedError(
  "@pf/VerifiedEmailRequiredError",
)<{
  readonly provider: string
  readonly subject: string
}> {}

/**
 * Raised when a verified-identity first login would create a Provider User for an
 * email already owned by a different provider subject. Account linking is out of
 * scope; fail closed instead of a unique-index 500.
 */
export class ProviderUserEmailAlreadyOwnedError extends Data.TaggedError(
  "@pf/ProviderUserEmailAlreadyOwnedError",
)<{
  readonly email: string
  readonly provider: string
  readonly subject: string
  readonly existingProvider: string
  readonly existingSubject: string
}> {}

/**
 * Schema for dummy provider ID token payload (and legacy test fixtures).
 */
export const GoogleIdTokenSchema = Schema.Struct({
  sub: Schema.String,
  email: Schema.String,
  name: Schema.String,
  given_name: Schema.optionalWith(Schema.String, { exact: true }),
  family_name: Schema.optionalWith(Schema.String, { exact: true }),
  picture: Schema.optionalWith(Schema.String, { exact: true }),
  locale: Schema.optionalWith(Schema.String, { exact: true }),
  email_verified: Schema.optionalWith(Schema.Boolean, { exact: true }),
})

export type GoogleIdToken = Schema.Schema.Type<typeof GoogleIdTokenSchema>

const ProviderSubjectSchema = Schema.Struct({ sub: Schema.String })

const touchExistingProviderUser = (
  providerUser: ProviderUserRecord,
  picture: string | undefined,
) =>
  Effect.gen(function* () {
    const db = yield* AuthenticationDatabase
    const now = yield* DateTime.now
    yield* withNonCriticalRetry(
      db.updateLastLoggedIn(providerUser.id, now),
      "updateLastLoggedIn",
    )
    if (picture && picture !== providerUser.picture) {
      yield* withNonCriticalRetry(
        db.updateProviderUserProfilePicture(providerUser.id, picture),
        "updateProviderUserProfilePicture",
      )
    }
    const roles = yield* db.findProviderUserRoles(providerUser.id)
    return { ...providerUser, roles }
  })

/**
 * Existing Provider User continuity by stable provider subject.
 * Does not create users or accept invitations.
 */
export const findExistingProviderUserBySubject = (
  identity: ProviderSubjectIdentity,
) =>
  Effect.gen(function* () {
    const db = yield* AuthenticationDatabase
    const existing = yield* db.findProviderUserByProviderSub(
      identity.provider,
      identity.subject,
    )

    if (Option.isSome(existing) && existing.value) {
      return yield* touchExistingProviderUser(existing.value, identity.picture)
    }

    return yield* new VerifiedEmailRequiredError({
      provider: identity.provider,
      subject: identity.subject,
    })
  })

/**
 * Find or create a Provider User from a verified human identity.
 * First-user creation and invitation role assignment require this contract.
 */
export const findOrCreateProviderUserFromVerifiedIdentity = (
  identity: VerifiedHumanIdentity,
) =>
  Effect.gen(function* () {
    const db = yield* AuthenticationDatabase

    const existingByProviderSub = yield* db.findProviderUserByProviderSub(
      identity.provider,
      identity.subject,
    )

    if (Option.isSome(existingByProviderSub) && existingByProviderSub.value) {
      return yield* touchExistingProviderUser(
        existingByProviderSub.value,
        identity.profile.picture,
      )
    }

    // Email is unique across Provider Users. Do not auto-link a different
    // provider subject to an existing identity; fail closed before create.
    const existingByEmail = yield* db.findProviderUserByEmail(identity.email)
    if (Option.isSome(existingByEmail) && existingByEmail.value) {
      const owner = existingByEmail.value
      return yield* new ProviderUserEmailAlreadyOwnedError({
        email: identity.email,
        provider: identity.provider,
        subject: identity.subject,
        existingProvider: owner.provider,
        existingSubject: owner.sub,
      })
    }

    const inviteOnly = yield* resolveInviteOnlyForProvider(identity.provider)
    const invitationRoleIds = yield* db.findInvitationRoleIds(identity.email)
    const googleInvite =
      identity.provider === "google"
        ? yield* resolveGoogleOuInvite(db, identity.email)
        : { matched: false, roleIds: [] as string[] }

    if (inviteOnly && invitationRoleIds.length === 0 && !googleInvite.matched) {
      return yield* new InviteRequiredError({ email: identity.email })
    }

    const rootOrgUnit = yield* db.findRootOrgUnit()

    if (Option.isNone(rootOrgUnit) || !rootOrgUnit.value) {
      return yield* new RootOrgUnitNotFoundError({
        message: "No root organization unit found in database",
      })
    }

    const root = rootOrgUnit.value
    const providerUserData: CreateProviderUserInput = {
      email: identity.email,
      name: identity.profile.name,
      firstName: identity.profile.givenName ?? "",
      lastName: identity.profile.familyName ?? "",
      picture: identity.profile.picture ?? "",
      locale: identity.profile.locale ?? "",
      provider: identity.provider,
      sub: identity.subject,
      orgUnitId: root.id,
    }

    const newProviderUser = yield* db.createProviderUser(providerUserData)

    if (invitationRoleIds.length > 0) {
      yield* db.assignProviderUserRoles(newProviderUser.id, invitationRoleIds)
      const acceptedAt = yield* DateTime.now
      const accepted = yield* db.acceptPendingInvitationForUser({
        email: identity.email,
        userId: newProviderUser.id,
        provider: identity.provider,
        subject: identity.subject,
        acceptedAt,
      })
      // Concurrent acceptance can win between role load and accept; roll back so
      // no partial identity remains when this transaction cannot consume the grant.
      if (!accepted) {
        return yield* new InviteRequiredError({ email: identity.email })
      }
    }

    if (invitationRoleIds.length === 0 && googleInvite.roleIds.length > 0) {
      yield* db.assignProviderUserRoles(
        newProviderUser.id,
        googleInvite.roleIds,
      )
    }

    const roles = yield* db.findProviderUserRoles(newProviderUser.id)
    return { ...newProviderUser, roles }
  })

/**
 * Dummy-provider login for existing users only.
 * Reuses by provider subject, then by email; never creates a Provider User.
 */
export const findDummyProviderUser = (idToken: unknown) =>
  Effect.gen(function* () {
    const db = yield* AuthenticationDatabase
    const subjectToken = yield* Schema.decodeUnknown(ProviderSubjectSchema)(
      idToken,
    )

    const existingByProviderSub = yield* db.findProviderUserByProviderSub(
      "dummy",
      subjectToken.sub,
    )

    if (Option.isSome(existingByProviderSub) && existingByProviderSub.value) {
      return yield* touchExistingProviderUser(
        existingByProviderSub.value,
        undefined,
      )
    }

    const token = yield* Schema.decodeUnknown(GoogleIdTokenSchema)(idToken)
    const existingByEmail = yield* db.findProviderUserByEmail(token.email)

    if (Option.isSome(existingByEmail) && existingByEmail.value) {
      return yield* touchExistingProviderUser(existingByEmail.value, undefined)
    }

    return yield* new DummyProviderUserNotFoundError({ email: token.email })
  })

/**
 * Attempt to resolve and assign roles based on Google Workspace OU membership.
 *
 * Loads the Google provider config from DB, checks if OU-based invitations
 * are configured, fetches the user's OU from Google Directory API, and assigns
 * matching roles. All errors are caught and logged — never blocks user creation.
 */
const resolveGoogleOuInvite = (
  db: Effect.Effect.Success<typeof AuthenticationDatabase>,
  email: string,
) =>
  Effect.gen(function* () {
    const providerRecord = yield* db.findOAuthProviderByName("google")
    if (Option.isNone(providerRecord)) {
      return { matched: false, roleIds: [] as string[] }
    }

    const configResult = yield* Schema.decodeUnknown(
      GoogleOAuthProviderConfigSchema,
    )(providerRecord.value.config).pipe(Effect.either)

    return yield* Either.match(configResult, {
      onLeft: () =>
        Effect.gen(function* () {
          yield* Effect.logWarning(
            "Failed to decode Google provider config for OU check",
          )
          return { matched: false, roleIds: [] as string[] }
        }),
      onRight: (config) =>
        Effect.gen(function* () {
          const {
            invitedOrgUnits,
            orgUnitAsRole,
            serviceAccountKey,
            adminEmail,
          } = config

          if (
            !invitedOrgUnits ||
            invitedOrgUnits.length === 0 ||
            !serviceAccountKey ||
            !adminEmail
          ) {
            return { matched: false, roleIds: [] as string[] }
          }

          const orgUnitPath = yield* fetchUserOrgUnitPath(
            email,
            serviceAccountKey,
            adminEmail,
          ).pipe(
            Effect.catchAll((e) => {
              return Effect.logWarning(
                `Google Directory API error for ${email}: ${e.message}`,
              ).pipe(Effect.as(undefined))
            }),
          )

          if (!orgUnitPath) {
            return { matched: false, roleIds: [] as string[] }
          }

          // Check if the user's OU matches any invited OU
          const matched = invitedOrgUnits.some((ou) => orgUnitPath === ou)
          if (!matched) {
            yield* Effect.logDebug(
              `User ${email} OU "${orgUnitPath}" does not match invited OUs`,
            )
            return { matched: false, roleIds: [] as string[] }
          }

          if (orgUnitAsRole) {
            // Map OU path directly to a role path
            const roleIds = yield* db.findRoleIdsByPaths([orgUnitPath])
            if (roleIds.length === 0) {
              yield* Effect.logWarning(
                `No role found matching OU path "${orgUnitPath}" for user ${email}`,
              )
            }
            return { matched: true, roleIds }
          }

          // Matching OU membership still counts as an invite even when role
          // mapping is handled separately from Google OU paths.
          return { matched: true, roleIds: [] as string[] }
        }),
    })
  }).pipe(
    Effect.catchAll((e) =>
      Effect.logWarning(`OU-based role assignment failed: ${e}`).pipe(
        Effect.as({ matched: false, roleIds: [] as string[] }),
      ),
    ),
  )
