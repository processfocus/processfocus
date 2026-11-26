import { Context, Effect, Option } from "effect"
import {
  Audit,
  type DeploymentAuditDetails,
  captureAudit,
} from "./lib/audit.js"

/** Only the AWS runtime enables deployment auditing. */
export const CloudDeploymentAuditing = Context.Reference<boolean>(
  "@pf/audit/CloudDeploymentAuditing",
  { defaultValue: () => false },
)

/** Backend-owned lookup keeps project schema and process paths out of handlers. */
export class DeploymentAuditTarget extends Context.Service<
  DeploymentAuditTarget,
  {
    readonly resolve: (
      executionId: string,
    ) => Effect.Effect<DeploymentAuditDetails | undefined, unknown>
  }
>()("@pf/audit/DeploymentAuditTarget") {}

/** Call after the existing acceptance/result transaction commits. */
export const recordDeploymentAudit = (
  executionId: string,
  event:
    | {
        readonly subtype: "started" | "restarted"
        readonly actor: { readonly by: string; readonly id: string | null }
      }
    | { readonly subtype: "succeeded" }
    | {
        readonly subtype: "failed"
        readonly summary?: "Deployment failed" | "Deployment cancelled"
      },
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (!(yield* CloudDeploymentAuditing)) return
    const target = yield* Effect.serviceOption(DeploymentAuditTarget)
    const audit = yield* Effect.serviceOption(Audit)
    if (Option.isNone(target) || Option.isNone(audit)) return
    const details = yield* target.value.resolve(executionId)
    if (!details) return
    const attribution =
      "actor" in event
        ? { actorBy: event.actor.by, actorUserId: event.actor.id }
        : {}
    const captured = yield* captureAudit({
      type: "deploy",
      details:
        event.subtype === "failed"
          ? {
              ...details,
              subtype: event.subtype,
              summary: event.summary ?? "Deployment failed",
            }
          : { ...details, ...attribution, subtype: event.subtype },
    })
    yield* audit.value.deliver(captured)
  }).pipe(
    Effect.catchCause(() =>
      Effect.logWarning("Deployment audit recording failed", { executionId }),
    ),
  )
