import { Effect } from "effect"
import type { Oauth2Token } from "@pf/openauth/provider/oauth2"
import type {
  ProviderSubjectIdentity,
  VerifiedHumanIdentity,
} from "@pf/openauth/provider/provider"
import type { AuthenticationDatabase } from "../authentication-database.js"
import {
  VerifiedEmailRequiredError,
  findDummyProviderUser,
  findExistingProviderUserBySubject,
  findOrCreateProviderUserFromVerifiedIdentity,
} from "../provider-user-auth.js"
import { type SuccessResult, optionalProviderUserPicture } from "./types.js"

/**
 * Value passed to the success handler for the dummy provider (and any residual
 * non-human OAuth tokenset path). Human OAuth/OIDC adapters no longer return this.
 */
export interface Oauth2Value {
  readonly provider: string
  readonly tokenset: Oauth2Token
  readonly clientID: string
}

const isVerifiedHumanIdentity = (
  value: Oauth2Value | VerifiedHumanIdentity | ProviderSubjectIdentity,
): value is VerifiedHumanIdentity =>
  "type" in value && value.type === "verified-human-identity"

const isProviderSubjectIdentity = (
  value: Oauth2Value | VerifiedHumanIdentity | ProviderSubjectIdentity,
): value is ProviderSubjectIdentity =>
  "type" in value && value.type === "provider-subject-identity"

const tokensetSubject = (tokenset: Oauth2Token): string | undefined => {
  const subject = tokenset.id?.["sub"]
  return typeof subject === "string" && subject.length > 0 ? subject : undefined
}

const tokensetPicture = (tokenset: Oauth2Token): string | undefined => {
  const picture = tokenset.id?.["picture"]
  return typeof picture === "string" && picture.length > 0 ? picture : undefined
}

/**
 * Residual non-dummy tokenset: existing-user subject continuity only (no create).
 */
const findExistingFromResidualTokenset = (value: Oauth2Value) =>
  Effect.gen(function* () {
    const subject = tokensetSubject(value.tokenset)
    if (!subject) {
      return yield* new VerifiedEmailRequiredError({
        provider: value.provider,
        subject: "unknown",
      })
    }
    const picture = tokensetPicture(value.tokenset)
    return yield* findExistingProviderUserBySubject({
      type: "provider-subject-identity",
      provider: value.provider,
      subject,
      ...(picture ? { picture } : {}),
    })
  })

/**
 * Handle OAuth2 authentication success.
 *
 * - Verified human identity: find or create Provider User (Invitation roles on create)
 * - Provider subject only: existing Provider User continuity
 * - Dummy tokenset: existing users only (by subject or email)
 * - Residual non-dummy tokenset: existing-user continuity by subject only (no create)
 *
 * Note: Transaction handling is done by the caller in create-authentication-server.ts
 */
export const handleOauth2Success = (
  value: Oauth2Value | VerifiedHumanIdentity | ProviderSubjectIdentity,
): Effect.Effect<SuccessResult, unknown, AuthenticationDatabase> =>
  Effect.gen(function* () {
    const providerUser = isVerifiedHumanIdentity(value)
      ? yield* findOrCreateProviderUserFromVerifiedIdentity(value)
      : isProviderSubjectIdentity(value)
        ? yield* findExistingProviderUserBySubject(value)
        : value.provider === "dummy"
          ? yield* findDummyProviderUser(value.tokenset.id)
          : yield* findExistingFromResidualTokenset(value)

    yield* Effect.log("User logged in").pipe(
      Effect.annotateLogs({
        provider: providerUser.provider,
        sub: providerUser.sub,
        id: providerUser.id,
        email: providerUser.email,
        roles: providerUser.roles,
      }),
    )

    return {
      type: "providerUser" as const,
      properties: {
        userId: providerUser.id,
        email: providerUser.email,
        picture: optionalProviderUserPicture(providerUser.picture),
        orgUnitId: providerUser.orgUnitId,
        orgUnitPath: providerUser.orgUnitPath,
        roles: providerUser.roles,
        ...(isVerifiedHumanIdentity(value) ||
        isProviderSubjectIdentity(value) ||
        value.provider === "dummy"
          ? { humanSession: true as const }
          : {}),
      },
    }
  })
