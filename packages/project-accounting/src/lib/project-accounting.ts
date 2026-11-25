import { Context, type Effect, Schema } from "effect"
import type { CurrentPrincipal } from "@pf/auth-policy"

/** Durable invalidations carry identity only; consumers pull canonical totals. */
export const PROJECT_ACCOUNTING_QUEUE = "project-accounting-event"
/** Lifecycle and phase producers signal the same authorized snapshot pull. */
export const DeploymentChange = Schema.Struct({
  deployment: Schema.Struct({
    projectId: Schema.String,
    environmentId: Schema.String,
  }),
})
export type DeploymentChange = typeof DeploymentChange.Type

export const ProjectAccountingChange = Schema.Union([
  Schema.Struct({ projectId: Schema.String }),
  Schema.Struct({ recipientPrincipalId: Schema.String }),
  DeploymentChange,
])
export type ProjectAccountingChange = Schema.Schema.Type<
  typeof ProjectAccountingChange
>

/** Runtime publication boundary, independent of processes and queue transport.
 * Service identifiers retain their historical spelling for bundle compatibility.
 */
export class ProjectAccountingEvents extends Context.Service<
  ProjectAccountingEvents,
  {
    readonly emit: (
      event: ProjectAccountingChange,
    ) => Effect.Effect<void, unknown>
    readonly subscribe: (
      projectId: string,
      recipientPrincipalId: string,
      environmentId?: string,
    ) => Effect.Effect<AsyncIterable<ProjectAccountingChange>>
  }
>()("@pf/queue-service/ProjectAccountingEvents") {}

/** Organisation-owned visibility evaluated under the current subscriber principal. */
export class ProjectAccountingVisibility extends Context.Service<
  ProjectAccountingVisibility,
  {
    readonly canReceive: (
      projectId: string,
    ) => Effect.Effect<boolean, unknown, CurrentPrincipal>
    readonly canReceiveDeployment?: (
      target: DeploymentChange["deployment"],
    ) => Effect.Effect<boolean, unknown, CurrentPrincipal>
  }
>()("@pf/queue-service/ProjectAccountingVisibility") {}
