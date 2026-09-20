import { sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import * as schema from "@pf/drizzle-sqlite"
import {
  ExternalParticipantOperations,
  InvalidExternalParticipantEmail,
  getUserDetails,
  normalizeExternalParticipantEmail,
  returnedRow,
} from "@pf/graphql-db-operations"
import { getRequestTime } from "@pf/request-time"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"

export const SqliteExternalParticipantOperationsLive = Layer.effect(
  ExternalParticipantOperations,
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle

    return {
      upsertByEmail: (email: string) =>
        Effect.gen(function* () {
          const normalizedEmail = normalizeExternalParticipantEmail(email)
          if (normalizedEmail === null) {
            return yield* new InvalidExternalParticipantEmail({
              email,
              message:
                "External participant email must be a valid email address",
            })
          }

          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()
          const rows = yield* db
            .insert(schema.externalParticipant)
            .values({
              email: normalizedEmail,
              createdAt: requestTime,
              updatedAt: requestTime,
              createdBy: userDetails.by,
              updatedBy: userDetails.by,
            })
            .onConflictDoUpdate({
              target: schema.externalParticipant.email,
              // Keep textually identical to the SQLite partial unique index.
              // Drizzle's typed eq() emits a table-qualified parameterized
              // predicate, which SQLite does not match to this index.
              targetWhere: sql`_deleted = 0`,
              set: {
                updatedAt: requestTime,
                updatedBy: userDetails.by,
              },
            })
            .returning({ id: schema.externalParticipant.id })

          return (yield* returnedRow(rows)).id
        }),
    }
  }),
)
