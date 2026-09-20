import { Schema } from "effect"
import { createSubjects } from "@pf/openauth/subject"

const user = Schema.Struct({
  // "user" is the OpenAuth subject key for service-account/M2M sessions.
  userId: Schema.String,
  clientId: Schema.String, // The M2M client identifier (e.g., "ci-pipeline")
  roles: Schema.optional(Schema.Array(Schema.String)), // Role paths (for M2M/CI users)
  orgUnitId: Schema.optional(Schema.String), // Org unit ID (from role's org unit)
  orgUnitPath: Schema.optional(Schema.String), // Org unit path (from role's org unit)
})

const providerUser = Schema.Struct({
  userId: Schema.String,
  email: Schema.String,
  picture: Schema.optional(Schema.String),
  orgUnitId: Schema.String,
  orgUnitPath: Schema.String, // e.g. "/"
  roles: Schema.Array(Schema.String), // Role paths
  // Issuer-established human login/registration provenance, not freshness or MFA.
  // Absent on M2M impersonation, delegated sessions, and legacy sessions.
  humanSession: Schema.optional(Schema.Literal(true)),
  // Session role switching, not a Delegation permission ceiling. Absent means all current assignments.
  delegationRoleSelection: Schema.optional(Schema.Array(Schema.String)),
  delegation: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      generationId: Schema.String,
      name: Schema.String,
      expiresAt: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
    }),
  ),
  // Only the issuer's verified human ceremony may establish this evidence.
  humanAuthentication: Schema.optional(
    Schema.Struct({
      providerUserId: Schema.String,
      authenticatedAt: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
      method: Schema.Literal("passkey"),
    }),
  ),
})

export const ProviderUserSessionSchema = providerUser

export const subjects = createSubjects({
  user: Schema.standardSchemaV1(user),
  providerUser: Schema.standardSchemaV1(providerUser),
})

export type Subjects = typeof subjects
export type ServiceAccountSession = Schema.Schema.Type<typeof user>
export type ProviderUserSession = Schema.Schema.Type<typeof providerUser>
/** Provider User subjects include human, delegated, and M2M impersonation sessions. */
export type Session = ServiceAccountSession | ProviderUserSession
