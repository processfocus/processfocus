import { Context, Data, type Effect } from "effect"

export class PolicyRevisionUnavailable extends Data.TaggedError(
  "PolicyRevisionUnavailable",
)<Record<never, never>> {}

/** Opaque activation identity. Reading it never initializes a policy engine. */
export class ActivePolicyRevision extends Context.Service<
  ActivePolicyRevision,
  {
    readonly current: Effect.Effect<string, PolicyRevisionUnavailable>
  }
>()("@pf/auth-policy/ActivePolicyRevision") {}

/** Only the authorization runtime publishes successfully activated revisions. */
export class PolicyRevisionPublisher extends Context.Service<
  PolicyRevisionPublisher,
  {
    readonly publish: (
      revision: string,
    ) => Effect.Effect<void, PolicyRevisionUnavailable>
  }
>()("@pf/auth-policy/PolicyRevisionPublisher") {}
