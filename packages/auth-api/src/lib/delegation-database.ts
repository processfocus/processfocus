import { Context, type DateTime, type Effect, type Option } from "effect"
import type { ProviderUserSession } from "@pf/auth-session"
import type {
  DatabaseQueryError,
  DatabaseWriteError,
} from "./authentication-database.js"

export interface DelegationRecord {
  readonly id: string
  readonly name: string
  readonly generationId: string
  readonly createdAt: DateTime.Utc
  readonly expiresAt: DateTime.Utc
  readonly revokedAt: DateTime.Utc | null
  readonly lastUsedAt: DateTime.Utc | null
}

export interface DelegationGeneration extends DelegationRecord {
  readonly parentGenerationId: string | null
  readonly ownerId: string
  readonly userId: string
  readonly generationRevokedAt: DateTime.Utc | null
}

/** Metadata-only storage boundary. Callers own issuance policy and transactions. */
export class DelegationDatabase extends Context.Tag(
  "@pf/auth-api/DelegationDatabase",
)<
  DelegationDatabase,
  {
    /** Includes superseded/deleted generations: submission IDs are never reusable. */
    readonly hasGeneration: (
      generationId: string,
    ) => Effect.Effect<boolean, DatabaseQueryError>
    readonly findGeneration: (
      lookup: { readonly verifier: string } | { readonly generationId: string },
    ) => Effect.Effect<Option.Option<DelegationGeneration>, DatabaseQueryError>
    readonly recordUse: (input: {
      readonly generationId: string
      readonly usedAt: DateTime.Utc
    }) => Effect.Effect<void, DatabaseWriteError>
    readonly recordLogin: (input: {
      readonly delegationId: string
      readonly generationId: string
      readonly ownerId: string
      readonly loggedInAt: DateTime.Utc
    }) => Effect.Effect<void, DatabaseWriteError>
    /** Aggregated anonymous-login presentation choice; never authorization. */
    readonly isSecretLoginEnabled: () => Effect.Effect<
      boolean,
      DatabaseQueryError
    >
    readonly findOwnerId: (
      userId: string,
    ) => Effect.Effect<Option.Option<string>, DatabaseQueryError>
    readonly list: (
      ownerId: string,
    ) => Effect.Effect<readonly DelegationRecord[], DatabaseQueryError>
    readonly releaseExpiredNames: (
      ownerId: string,
      now: DateTime.Utc,
    ) => Effect.Effect<void, DatabaseWriteError>
    readonly claimName: (input: {
      readonly id: string
      readonly ownerId: string
      readonly name: string
    }) => Effect.Effect<boolean, DatabaseWriteError>
    readonly updateName: (input: {
      readonly id: string
      readonly name: string
      readonly activeName: string | null
    }) => Effect.Effect<void, DatabaseWriteError>
    readonly revokeGeneration: (input: {
      readonly generationId: string
      readonly revokedAt: DateTime.Utc
    }) => Effect.Effect<void, DatabaseWriteError>
    readonly revoke: (input: {
      readonly id: string
      readonly revokedAt: DateTime.Utc
    }) => Effect.Effect<void, DatabaseWriteError>
    readonly recordChange: (
      input: {
        readonly delegationId: string
        readonly generationId: string
        readonly actorId: string
        readonly actorDelegation?:
          | Pick<
              NonNullable<ProviderUserSession["delegation"]>,
              "id" | "generationId"
            >
          | undefined
        readonly occurredAt: DateTime.Utc
      } & (
        | {
            readonly event: "renamed"
            readonly oldName: string
            readonly newName: string
          }
        | { readonly event: "replaced" | "revoked" }
      ),
    ) => Effect.Effect<void, DatabaseWriteError>
    readonly insertGeneration: (input: {
      readonly id: string
      readonly delegationId: string
      readonly parentGenerationId?: string | null | undefined
      readonly verifier: string
      readonly issuedAt: DateTime.Utc
      readonly expiresAt: DateTime.Utc
    }) => Effect.Effect<void, DatabaseWriteError>
    readonly recordIssuance: (input: {
      readonly delegationId: string
      readonly generationId: string
      readonly actorId: string
      readonly actorDelegation?:
        | Pick<
            NonNullable<ProviderUserSession["delegation"]>,
            "id" | "generationId"
          >
        | undefined
      readonly issuedAt: DateTime.Utc
    }) => Effect.Effect<void, DatabaseWriteError>
  }
>() {}
