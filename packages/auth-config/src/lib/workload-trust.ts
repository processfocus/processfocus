import { Schema } from "effect"

const text = Schema.String.pipe(Schema.check(Schema.isMinLength(1)))

/** Code-owned admission policy. PF issuer pins the organisation/project/environment. */
export const WorkloadTrustBindingSchema = Schema.Struct({
  id: text,
  targetIssuer: text,
  issuer: Schema.Literal("https://token.actions.githubusercontent.com"),
  assertionAudience: text,
  repositoryId: text,
  repositoryOwnerId: text,
  workflowRef: text,
  jobWorkflowRef: Schema.optional(text),
  refs: Schema.Array(text),
  events: Schema.Array(text),
  environment: text,
  lifetimeSeconds: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    // Access-only generation rounds the deadline and remaining lifetime down.
    Schema.check(Schema.isGreaterThanOrEqualTo(2)),
    Schema.check(Schema.isLessThanOrEqualTo(5400)),
  ),
})

export type WorkloadTrustBinding = Schema.Schema.Type<
  typeof WorkloadTrustBindingSchema
>
export const WorkloadTrustConfigSchema = Schema.Struct({
  bindings: Schema.Array(WorkloadTrustBindingSchema),
  databaseTransferProjects: Schema.optional(Schema.Array(text)),
  deploymentProjects: Schema.optional(Schema.Array(text)),
})
export interface WorkloadClientConfig {
  readonly audience: string
  readonly bindings: readonly WorkloadTrustBinding[]
  readonly databaseTransferProjects?: readonly string[]
  readonly deploymentProjects?: readonly string[]
}
