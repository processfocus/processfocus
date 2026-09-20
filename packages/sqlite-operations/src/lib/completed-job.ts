import { and, eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import * as schema from "@pf/drizzle-sqlite"
import {
  CompletedJobOperations,
  getUserDetails,
} from "@pf/graphql-db-operations"
import { getRequestTime } from "@pf/request-time"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"

/**
 * Live implementation of CompletedJobOperations service for SQLite.
 */
export const SqliteCompletedJobOperationsLive = Layer.effect(
  CompletedJobOperations,
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle

    return {
      isJobCompleted: (queue: string, jobId: string) =>
        Effect.gen(function* () {
          const result = yield* db
            .select({ id: schema.completedJob.id })
            .from(schema.completedJob)
            .where(
              and(
                eq(schema.completedJob.queue, queue),
                eq(schema.completedJob.jobId, jobId),
                eq(schema.completedJob._deleted, false),
              ),
            )
            .limit(1)

          return result.length > 0
        }),

      markJobCompleted: (queue: string, jobId: string) =>
        db.insert(schema.completedJob).values({
          queue,
          jobId,
        }),

      clearJobCompleted: (queue: string, jobId: string) =>
        Effect.gen(function* () {
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()

          yield* db
            .update(schema.completedJob)
            .set({
              _deleted: true,
              updatedAt: requestTime,
              updatedBy: userDetails.by,
            })
            .where(
              and(
                eq(schema.completedJob.queue, queue),
                eq(schema.completedJob.jobId, jobId),
                eq(schema.completedJob._deleted, false),
              ),
            )
        }),
    }
  }),
)
