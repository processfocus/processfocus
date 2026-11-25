import { Clock, Context, Effect, Schema } from "effect"
import type { SqlError } from "effect/sql/SqlError"

const Login = Schema.Struct({
  type: Schema.Literal("login"),
  details: Schema.Struct({
    actorUserId: Schema.String,
    authenticationMethod: Schema.Literals(["oauth", "passkey", "dummy"]),
  }),
})
const Logout = Schema.Struct({
  type: Schema.Literal("logout"),
  details: Schema.Struct({ actorUserId: Schema.String }),
})
const ConfigSet = Schema.Struct({
  type: Schema.Literal("config-set"),
  details: Schema.Struct({
    actorUserId: Schema.String,
    actorBy: Schema.String,
    projectNumber: Schema.String,
    stageName: Schema.String,
    key: Schema.String,
    isSecret: Schema.Boolean,
  }),
})
export const DeploymentAuditDetails = Schema.Struct({
  executionId: Schema.String,
  projectNumber: Schema.String,
  environmentName: Schema.String,
  // Older retained events predate the canonical IDs used for live delivery.
  target: Schema.optional(
    Schema.Struct({ projectId: Schema.String, environmentId: Schema.String }),
  ),
  initiatedBy: Schema.String,
  initiatorUserId: Schema.NullOr(Schema.String),
  actorBy: Schema.optional(Schema.String),
  actorUserId: Schema.optional(Schema.NullOr(Schema.String)),
})
export type DeploymentAuditDetails = typeof DeploymentAuditDetails.Type
const Deploy = Schema.Struct({
  type: Schema.Literal("deploy"),
  details: Schema.Union([
    Schema.Struct({
      ...DeploymentAuditDetails.fields,
      subtype: Schema.Literals(["started", "restarted", "succeeded"]),
    }),
    Schema.Struct({
      ...DeploymentAuditDetails.fields,
      subtype: Schema.Literal("failed"),
      summary: Schema.Literals(["Deployment failed", "Deployment cancelled"]),
    }),
  ]),
})
export const AuditAction = Schema.Union([Login, Logout, ConfigSet, Deploy])
export type AuditAction = typeof AuditAction.Type
export const AuditEvent = Schema.Struct({
  id: Schema.String,
  occurredAt: Schema.Number,
  action: AuditAction,
})
export type AuditEvent = typeof AuditEvent.Type

/** Capture at the action's evidence boundary; deliver once its success is confirmed. */
export const captureAudit = (action: AuditAction): Effect.Effect<AuditEvent> =>
  Effect.gen(function* () {
    const occurredAt = yield* Clock.currentTimeMillis
    return { id: crypto.randomUUID(), occurredAt, action }
  })

export class AuditPersistence extends Context.Service<
  AuditPersistence,
  { readonly insert: (event: AuditEvent) => Effect.Effect<void, SqlError> }
>()("@pf/audit/AuditPersistence") {}

export class Audit extends Context.Service<
  Audit,
  { readonly deliver: (event: AuditEvent) => Effect.Effect<void> }
>()("@pf/audit/Audit") {}

/** Runtime delivery is bounded, awaited, and never changes the action's outcome. */
export const makeAudit = <E>(
  deliver: (event: AuditEvent) => Effect.Effect<unknown, E>,
): Audit["Service"] => ({
  deliver: (event) =>
    Effect.gen(function* () {
      yield* Effect.logInfo("Audit event", { audit: event })
      yield* deliver(event).pipe(
        Effect.timeout(250),
        Effect.catchCause(() =>
          // Never log delivery errors: drivers can include SQL parameters or credentials.
          Effect.logWarning("Audit delivery failed or timed out", {
            auditId: event.id,
          }),
        ),
      )
    }),
})
