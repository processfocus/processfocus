import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import * as schema from "@pf/drizzle-postgres"
import {
  ExternalParticipantOperations,
  InvalidExternalParticipantEmail,
  getUserDetails,
  normalizeExternalParticipantEmail,
  returnedRow,
} from "@pf/graphql-db-operations"
import { getRequestTime } from "@pf/request-time"
import { TypedPostgresDrizzle } from "@pf/service-drizzle-postgres"

export const PostgresExternalParticipantOperationsLive = Layer.effect(
  ExternalParticipantOperations,
  Effect.gen(function* () {
    const db = yield* TypedPostgresDrizzle

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
              targetWhere: eq(schema.externalParticipant._deleted, false),
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
