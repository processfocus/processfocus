import { Context, type DateTime, type Effect } from "effect"
import type { SqlError } from "effect/sql/SqlError"

/** Persistence facts only. STS verification and binding selection belong to the caller. */
export class AwsRoleProofStore extends Context.Service<
  AwsRoleProofStore,
  {
    readonly clients: Effect.Effect<
      readonly { readonly clientId: string; readonly bindings: unknown }[],
      SqlError
    >
    readonly consume: (
      key: string,
      expiresAt: DateTime.Utc,
    ) => Effect.Effect<boolean, SqlError>
    readonly cleanup: (now: DateTime.Utc) => Effect.Effect<void, SqlError>
  }
>()("@pf/graphql-db-operations/AwsRoleProofStore") {}
