import type { SqlError } from "@effect/sql/SqlError"
import { Context, type Effect } from "effect"
import type { RequestTime } from "@pf/request-time"
import type { UserDetails } from "./user-details"

/**
 * Service providing database operations for system-executed steps.
 *
 * This service enables NodeStep execute functions to interact with the database.
 * Operations run in the context of the system user (no human user involved).
 */
export class SystemUserOperations extends Context.Tag(
  "@pf/graphql-db-operations/SystemUserOperations",
)<
  SystemUserOperations,
  {
    /**
     * Register an invitation in the database.
     * Inserts a new record into the invitation table.
     */
    readonly registerInvitation: (input: {
      invitationId: string
      email: string
    }) => Effect.Effect<void, SqlError, RequestTime | UserDetails>
  }
>() {}
