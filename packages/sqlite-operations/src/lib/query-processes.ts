import type { SqlError } from "@effect/sql/SqlError"
import { type SQL, and, eq, gt, inArray, isNotNull, or, sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import * as schema from "@pf/drizzle-sqlite"
import {
  ProcessCollectionQueries,
  type ProcessCollectionRow,
  ProcessQueries,
  type PullCheckpoint,
} from "@pf/graphql-db-operations"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"
import { retryTransientSqliteError } from "./transient-sqlite-error"

/**
 * Live implementation of ProcessQueries service for SQLite.
 */
export const SqliteProcessQueriesLive = Layer.effect(
  ProcessQueries,
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle

    return {
      queryAllProcesses: Effect.gen(function* () {
        const dbProcesses = yield* db.query.process
          .findMany({
            columns: {
              id: true,
              name: true,
              path: true,
              purpose: true,
              orgUnitId: true,
            },
            where: { _deleted: false },
            with: {
              orgUnit: {
                columns: {
                  id: true,
                  name: true,
                  orgUnitLevel: true,
                },
              },
            },
          })
          .pipe(retryTransientSqliteError)
        return dbProcesses
      }),
      listProcesses: (query) =>
        Effect.gen(function* () {
          const conditions = [eq(schema.process._deleted, false)]
          if (query.processPath != null) {
            conditions.push(eq(schema.process.path, query.processPath))
          }

          const rows = yield* db
            .select({
              id: schema.process.id,
              path: schema.process.path,
              name: schema.process.name,
              category: schema.orgUnit.name,
              purpose: schema.process.purpose,
              startStepPath: schema.step.path,
              activeInstances: schema.processItsActiveProcesses.activeProcesses,
            })
            .from(schema.process)
            .innerJoin(
              schema.orgUnit,
              eq(schema.process.orgUnitId, schema.orgUnit.id),
            )
            .innerJoin(
              schema.processItsStartStep,
              eq(schema.process.id, schema.processItsStartStep.id),
            )
            .innerJoin(
              schema.step,
              eq(schema.processItsStartStep.startStep, schema.step.id),
            )
            .leftJoin(
              schema.processItsActiveProcesses,
              eq(schema.process.id, schema.processItsActiveProcesses.id),
            )
            .where(and(...conditions))
            .orderBy(schema.process.path, schema.process.id)
            .limit(query.limit)
            .offset(query.offset)

          return rows.map((row) => ({
            ...row,
            activeInstances: row.activeInstances ?? 0,
          }))
        }).pipe(retryTransientSqliteError),
    }
  }),
)

/**
 * Live implementation of ProcessCollectionQueries service for SQLite.
 * Provides pull operations for RxDB replication.
 */
export const SqliteProcessCollectionQueriesLive = Layer.effect(
  ProcessCollectionQueries,
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle

    /**
     * Builds and executes the process query.
     * @param whereClause - The WHERE clause to apply (checkpoint filter or id filter)
     * @param limit - Optional limit for the query
     */
    const queryProcesses = (
      whereClause: SQL | undefined,
      limit?: number,
    ): Effect.Effect<ProcessCollectionRow[], SqlError> =>
      Effect.gen(function* () {
        // CTE for duration stats - single scan of process_execution table
        // instead of two correlated subqueries per process row
        const durationStats = db.$with("duration_stats").as(
          db
            .select({
              processId: schema.processState.processId,
              minDurationMs:
                sql<number>`MIN((${schema.processExecution.finishedAt} - ${schema.processExecution.createdAt}) * 86400000)`.as(
                  "min_duration_ms",
                ),
              maxDurationMs:
                sql<number>`MAX((${schema.processExecution.finishedAt} - ${schema.processExecution.createdAt}) * 86400000)`.as(
                  "max_duration_ms",
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
            .where(
              and(
                isNotNull(schema.processExecution.finishedAt),
                eq(schema.processExecution._deleted, false),
                eq(schema.processState._deleted, false),
              ),
            )
            .groupBy(schema.processState.processId),
        )

        // Query with raw SQL conversion for updatedAt
        // Join processItsStartStep view and step table to get start step path and form fields
        // Inner join ensures only processes with valid start steps are returned
        const baseQuery = db
          .with(durationStats)
          .select({
            id: schema.process.id,
            name: schema.process.name,
            path: schema.process.path,
            purpose: schema.process.purpose,
            updatedAt:
              sql<number>`CAST(ROUND((${schema.process.updatedAt} - 2440587.5) * 86400000) AS INTEGER)`.as(
                "updated_at_millis",
              ),
            deleted: schema.process._deleted,
            orgUnitId: schema.orgUnit.id,
            orgUnitName: schema.orgUnit.name,
            orgUnitLevel: schema.orgUnit.orgUnitLevel,
            startStepPath: schema.step.path,
            formFieldCount: schema.step.formFields,
            activeInstances: schema.processItsActiveProcesses.activeProcesses,
            minDurationMs: durationStats.minDurationMs,
            maxDurationMs: durationStats.maxDurationMs,
          })
          .from(schema.process)
          .innerJoin(
            schema.orgUnit,
            eq(schema.process.orgUnitId, schema.orgUnit.id),
          )
          .innerJoin(
            schema.processItsStartStep,
            eq(schema.process.id, schema.processItsStartStep.id),
          )
          .innerJoin(
            schema.step,
            eq(schema.processItsStartStep.startStep, schema.step.id),
          )
          .leftJoin(
            schema.processItsActiveProcesses,
            eq(schema.process.id, schema.processItsActiveProcesses.id),
          )
          .leftJoin(
            durationStats,
            eq(schema.process.id, durationStats.processId),
          )
          .where(whereClause)
          .orderBy(schema.process.updatedAt, schema.process.id)

        const query = limit !== undefined ? baseQuery.limit(limit) : baseQuery
        const rows = yield* query

        // Map to ProcessCollectionRow shape
        return rows.map(
          (row): ProcessCollectionRow => ({
            id: row.id,
            name: row.name,
            path: row.path,
            purpose: row.purpose,
            updatedAt: row.updatedAt,
            deleted: row.deleted,
            orgUnit: {
              id: row.orgUnitId,
              name: row.orgUnitName,
              orgUnitLevel: row.orgUnitLevel,
            },
            startStepPath: row.startStepPath,
            formFieldCount: row.formFieldCount ?? 0,
            activeInstances: row.activeInstances ?? 0,
            minDurationMs: row.minDurationMs,
            maxDurationMs: row.maxDurationMs,
          }),
        )
      })

    /**
     * Builds checkpoint filter for pull replication.
     * Filters: (updatedAt > checkpoint) OR (updatedAt = checkpoint AND id > checkpoint.id)
     */
    const buildCheckpointFilter = (
      checkpoint: PullCheckpoint | null | undefined,
    ): SQL | undefined => {
      if (!checkpoint) return undefined

      const updatedAtMillis = sql<number>`CAST(ROUND((${schema.process.updatedAt} - 2440587.5) * 86400000) AS INTEGER)`

      return or(
        gt(updatedAtMillis, checkpoint.updatedAt),
        and(
          eq(updatedAtMillis, checkpoint.updatedAt),
          gt(schema.process.id, checkpoint.id),
        ),
      )
    }

    return {
      pullProcess: (
        checkpoint: PullCheckpoint | null | undefined,
        limit: number,
      ) => queryProcesses(buildCheckpointFilter(checkpoint), limit),

      getProcesses: (ids: string[]) =>
        ids.length === 0
          ? Effect.succeed([])
          : queryProcesses(inArray(schema.process.id, ids)),
    }
  }),
)
