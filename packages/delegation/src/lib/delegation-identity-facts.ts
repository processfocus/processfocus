import { Context, type Effect, type Option } from "effect"
import type { DelegationQueryError } from "./delegation-errors.js"

export interface DelegationOwnerIdentity {
  readonly email: string
  readonly provider: string
  readonly orgUnitId: string
  readonly orgUnitPath: string
}

/** Live identity queries. Callers control timing and transaction context; never cache. */
export class DelegationIdentityFacts extends Context.Service<
  DelegationIdentityFacts,
  {
    readonly findProviderUserByUserId: (
      userId: string,
    ) => Effect.Effect<
      Option.Option<DelegationOwnerIdentity>,
      DelegationQueryError
    >
    readonly findProviderUserRoles: (
      userId: string,
    ) => Effect.Effect<string[], DelegationQueryError>
    readonly isPasskeyAvailable: () => Effect.Effect<
      boolean,
      DelegationQueryError
    >
  }
>()("@pf/delegation/DelegationIdentityFacts") {}
