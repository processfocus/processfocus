import { Schema } from "effect"

export const DelegationMetadata = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  generationId: Schema.String,
  expiresAt: Schema.String,
  createdAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
  revokedAt: Schema.NullOr(Schema.String),
  status: Schema.Literal("active", "expired", "revoked"),
  allowedActions: Schema.Struct({
    rename: Schema.Boolean,
    replace: Schema.Boolean,
    revoke: Schema.Boolean,
  }),
})

export type DelegationMetadata = typeof DelegationMetadata.Type

export const DelegationList = Schema.Struct({
  owner: Schema.Struct({ userId: Schema.String, email: Schema.String }),
  canIssue: Schema.Boolean,
  issuanceDeadline: Schema.NullOr(
    Schema.String.pipe(
      Schema.filter((value) => Number.isFinite(Date.parse(value))),
    ),
  ),
  delegations: Schema.Array(DelegationMetadata),
})

export const IssuedDelegation = Schema.Struct({
  ...DelegationMetadata.fields,
  secret: Schema.NonEmptyString,
})

export const CreateDelegation = Schema.Struct({
  requestId: Schema.optional(Schema.UUID),
  name: Schema.Trim.pipe(Schema.minLength(1)),
  lifetimeDays: Schema.Literal(1, 7, 14),
})

const staleGuards = {
  id: Schema.NonEmptyString,
  generationId: Schema.NonEmptyString,
  expectedName: Schema.NonEmptyString,
}

export const UpdateDelegation = Schema.Union(
  Schema.Struct({
    operation: Schema.Literal("rename"),
    ...staleGuards,
    name: CreateDelegation.fields.name,
  }),
  Schema.Struct({
    operation: Schema.Literal("replace"),
    ...staleGuards,
    name: CreateDelegation.fields.name,
    lifetimeDays: CreateDelegation.fields.lifetimeDays,
  }),
  Schema.Struct({ operation: Schema.Literal("revoke"), ...staleGuards }),
)
