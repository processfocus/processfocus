import { Context, Data, type Effect } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import type { RequestTime } from "@pf/request-time"
import type { UserDetails } from "./user-details"

export class InvalidExternalParticipantEmail extends Data.TaggedError(
  "InvalidExternalParticipantEmail",
)<{
  readonly email: string
  readonly message: string
}> {}

export const normalizeExternalParticipantEmail = (
  email: string,
): string | null => {
  const normalized = email.trim().toLowerCase()

  // Intentionally permissive: catch empty/obviously malformed values without
  // rejecting deliverable addresses that stricter local-part rules often miss.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    return null
  }

  return normalized
}

export class ExternalParticipantOperations extends Context.Service<
  ExternalParticipantOperations,
  {
    readonly upsertByEmail: (
      email: string,
    ) => Effect.Effect<
      string,
      SqlError | InvalidExternalParticipantEmail,
      RequestTime | UserDetails
    >
  }
>()("@pf/graphql-db-operations/ExternalParticipantOperations") {}
