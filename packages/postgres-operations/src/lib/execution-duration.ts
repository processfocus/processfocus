import { and, eq, inArray, isNotNull, lte, sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import * as schema from "@pf/drizzle-postgres"
import {
  ExecutionDurationQueries,
  type ExecutionTimestampPair,
} from "@pf/graphql-db-operations"
import { TypedPostgresDrizzle } from "@pf/service-drizzle-postgres"

/**
 * Live implementation of ExecutionDurationQueries for Postgres.
 * Uses window functions to efficiently sample N most recent executions per process.
 */
export const PostgresExecutionDurationQueriesLive = Layer.effect(
  ExecutionDurationQueries,
  Effect.gen(function* () {
    const db = yield* TypedPostgresDrizzle

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
                // Postgres uses EXTRACT(EPOCH FROM timestamp) * 1000 for epoch ms
                createdAt:
                  sql<number>`EXTRACT(EPOCH FROM ${schema.processExecution.createdAt}) * 1000`.as(
                    "created_at_ms",
                  ),
                finishedAt:
                  sql<number>`EXTRACT(EPOCH FROM ${schema.processExecution.finishedAt}) * 1000`.as(
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
