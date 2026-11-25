import { Schema } from "effect"
import { createSubjects } from "@pf/openauth/subject"

const workload = Schema.Struct({
  bindingId: Schema.String,
  deploymentAuthorityVersion: Schema.optional(Schema.String),
  repositoryId: Schema.String,
  repositoryOwnerId: Schema.String,
  workflowRef: Schema.String,
  jobWorkflowRef: Schema.optional(Schema.String),
  ref: Schema.String,
  event: Schema.String,
  environment: Schema.optional(Schema.String),
  sha: Schema.String,
  runId: Schema.String,
  runAttempt: Schema.String,
  expiresAt: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
})

const user = Schema.Struct({
  // "user" is the OpenAuth subject key for service-account/M2M sessions.
  userId: Schema.String,
  clientId: Schema.String,
  workload: Schema.optional(workload),
  awsRole: Schema.optional(
    Schema.Struct({
      provider: Schema.Literal("aws"),
      accountId: Schema.String,
      roleId: Schema.String,
      bindingId: Schema.String,
      requestId: Schema.String,
      expiresAt: Schema.Number,
    }),
  ),
  roles: Schema.optional(Schema.Array(Schema.String)), // Role paths (for M2M/CI users)
  orgUnitId: Schema.optional(Schema.String), // Org unit ID (from role's org unit)
  orgUnitPath: Schema.optional(Schema.String), // Org unit path (from role's org unit)
})

// Decode historical markers so acceptance can reject them, never erase them.
const retiredProviderUserWorkload = Schema.Struct({
  ...workload.fields,
  clientId: Schema.String,
  machineUserId: Schema.String,
})

const providerUser = Schema.Struct({
  // Established only by a validated upstream authorization callback.
  sso: Schema.optional(
    Schema.Struct({
      provider: Schema.NonEmptyString,
      subject: Schema.NonEmptyString,
      verifiedAt: Schema.Number.pipe(Schema.check(Schema.isInt())),
      expiresAt: Schema.Number.pipe(Schema.check(Schema.isInt())),
    }),
  ),
  authenticationMethod: Schema.optional(
    Schema.Literals(["passkey", "dummy", "client_credentials"]),
  ),
  // Issuer-generated identity of this login/exchange, retained on renewal.
  sessionId: Schema.optional(Schema.String),
  switchedRole: Schema.optional(Schema.String),
  temporaryRoleAuthority: Schema.optional(
    Schema.Struct({
      role: Schema.String,
      version: Schema.String,
      expiresAt: Schema.Number,
    }),
  ),
  workload: Schema.optional(retiredProviderUserWorkload),
  userId: Schema.String,
  email: Schema.String,
  picture: Schema.optional(Schema.String),
  orgUnitId: Schema.String,
  orgUnitPath: Schema.String, // e.g. "/"
  roles: Schema.Array(Schema.String), // Role paths
  // Issuer-established human login/registration provenance, not freshness or MFA.
  // Absent on delegated sessions and legacy sessions.
  humanSession: Schema.optional(Schema.Literal(true)),
  // Session role switching, not a Delegation permission ceiling. Absent means all current assignments.
  delegationRoleSelection: Schema.optional(Schema.Array(Schema.String)),
  delegation: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      generationId: Schema.String,
      name: Schema.String,
      expiresAt: Schema.Number.pipe(
        Schema.check(Schema.isInt()),
        Schema.check(Schema.isGreaterThanOrEqualTo(0)),
      ),
    }),
  ),
  // Only the issuer's verified human ceremony may establish this evidence.
  humanAuthentication: Schema.optional(
    Schema.Struct({
      providerUserId: Schema.String,
      authenticatedAt: Schema.Number.pipe(
        Schema.check(Schema.isInt()),
        Schema.check(Schema.isGreaterThanOrEqualTo(0)),
      ),
      method: Schema.Literal("passkey"),
    }),
  ),
}).check(
  Schema.makeFilter(
    (session) =>
      (session.workload === undefined &&
        session.authenticationMethod !== "client_credentials") ||
      "Machine-derived Provider User sessions are no longer accepted",
  ),
)

export const ProviderUserSessionSchema = providerUser
export const ServiceAccountSessionSchema = user

export const subjects = createSubjects({
  user: Schema.toStandardSchemaV1(user),
  providerUser: Schema.toStandardSchemaV1(providerUser),
})

export type Subjects = typeof subjects
export type ServiceAccountSession = Schema.Schema.Type<typeof user>
export type ProviderUserSession = Schema.Schema.Type<typeof providerUser>
/** Provider User subjects include human and delegated sessions. */
export type Session = ServiceAccountSession | ProviderUserSession
