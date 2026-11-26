import { Context, type Effect } from "effect"
import type { ServiceAccountPrincipal, UserPrincipal } from "./types"

/** Organisation-owned live grant for the project targeted by a deployment execution. */
export class DeploymentExecutionAccess extends Context.Service<
  DeploymentExecutionAccess,
  {
    readonly permits: (
      executionId: string,
      clientId: string,
      processPath: string,
    ) => Effect.Effect<boolean>
  }
>()("@pf/auth-policy/DeploymentExecutionAccess") {}

/** Live project/environment authorization before handing a workload an upload capability. */
export class WorkloadDatabaseUploadAccess extends Context.Service<
  WorkloadDatabaseUploadAccess,
  {
    readonly permits: (
      clientId: string,
      project: string,
      environment: string,
    ) => Effect.Effect<boolean>
  }
>()("@pf/auth-policy/WorkloadDatabaseUploadAccess") {}

/** Verified request actor; null represents unauthenticated or background work. */
export class CurrentPrincipal extends Context.Service<
  CurrentPrincipal,
  UserPrincipal | ServiceAccountPrincipal | null
>()("@pf/auth-policy/CurrentPrincipal") {}

export const getCurrentPrincipal = (): Effect.Effect<
  UserPrincipal | ServiceAccountPrincipal | null,
  never,
  CurrentPrincipal
> => CurrentPrincipal
