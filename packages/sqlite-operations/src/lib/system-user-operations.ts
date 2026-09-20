import { Effect, Layer } from "effect"
import * as schema from "@pf/drizzle-sqlite"
import { SystemUserOperations, getUserDetails } from "@pf/graphql-db-operations"
import { getRequestTime } from "@pf/request-time"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"

/**
 * Live implementation of SystemUserOperations service for SQLite.
 *
 * Contains database operations for system-executed steps.
 */
export const SqliteSystemUserOperationsLive = Layer.effect(
  SystemUserOperations,
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle

    return {
      registerInvitation: (input: { invitationId: string; email: string }) =>
        Effect.gen(function* () {
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()
          const normalizedEmail = input.email.trim().toLowerCase()

          yield* db.insert(schema.invitation).values({
            invitationId: input.invitationId,
            email: normalizedEmail,
            invitationStatus: "pending",
            invitationSource: "process",
            invitationPendingEmail: normalizedEmail,
            createdAt: requestTime,
            updatedAt: requestTime,
            createdBy: userDetails.by,
            updatedBy: userDetails.by,
          })
        }),
    }
  }),
)
