import { and, eq, inArray, isNotNull, lte, sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import * as schema from "@pf/drizzle-sqlite"
import {
  ExecutionDurationQueries,
  type ExecutionTimestampPair,
} from "@pf/graphql-db-operations"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"

/**
 * Live implementation of ExecutionDurationQueries for SQLite.
 * Uses window functions to efficiently sample N most recent executions per process.
 */
export const SqliteExecutionDurationQueriesLive = Layer.effect(
  ExecutionDurationQueries,
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle

    return {
      getExecutionTimestamps: (processIds, sampleSize) =>
        Effect.gen(function* () {
          if (processIds.length === 0) {
            return []
          }

          // Use a CTE with window function to get the N most recent executions per process
          // ROW_NUMBER() OVER (PARTITION BY process_id ORDER BY finished_at DESC)
          const rankedExecutions = db.$with("ranked_executions").as(
            db
              .select({
                processId: schema.processState.processId,
                orgUnitId: schema.process.orgUnitId,
                // SQLite stores effectDateTime as Julian Day, convert to epoch ms
                createdAt:
                  sql<number>`(${schema.processExecution.createdAt} - 2440587.5) * 86400000`.as(
                    "created_at_ms",
                  ),
                finishedAt:
                  sql<number>`(${schema.processExecution.finishedAt} - 2440587.5) * 86400000`.as(
                    "finished_at_ms",
                  ),
                rowNum:
                  sql<number>`ROW_NUMBER() OVER (PARTITION BY ${schema.processState.processId} ORDER BY ${schema.processExecution.finishedAt} DESC)`.as(
                    "row_num",
                  ),
              })
              .from(schema.processExecution)
              .innerJoin(
                schema.processState,
                eq(
                  schema.processExecution.processStateId,
                  schema.processState.id,
                ),
              )
              .innerJoin(
                schema.process,
                eq(schema.processState.processId, schema.process.id),
              )
              .where(
                and(
                  isNotNull(schema.processExecution.finishedAt),
                  eq(schema.processExecution._deleted, false),
                  eq(schema.processState._deleted, false),
                  eq(schema.process._deleted, false),
                  inArray(schema.processState.processId, processIds),
                ),
              ),
          )

          const rows = yield* db
            .with(rankedExecutions)
            .select({
              processId: rankedExecutions.processId,
              orgUnitId: rankedExecutions.orgUnitId,
              createdAt: rankedExecutions.createdAt,
              finishedAt: rankedExecutions.finishedAt,
            })
            .from(rankedExecutions)
            .where(lte(rankedExecutions.rowNum, sampleSize))

          return rows.map(
            (row): ExecutionTimestampPair => ({
              processId: row.processId,
              orgUnitId: row.orgUnitId,
              createdAt: row.createdAt,
              finishedAt: row.finishedAt,
            }),
          )
        }),
    }
  }),
)
