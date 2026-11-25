import { Context, type Effect } from "effect"

/** Optional admission policy supplied by a hosting runtime. */
export class WorkAdmission extends Context.Service<
  WorkAdmission,
  {
    /** Checks anew for each attempt; callers continue when the service is absent. */
    readonly admits: Effect.Effect<boolean>
  }
>()("@processfocus/runtime/WorkAdmission") {}
