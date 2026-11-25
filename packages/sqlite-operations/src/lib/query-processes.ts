import {
  type SQL,
  and,
  countDistinct,
  eq,
  gt,
  inArray,
  isNotNull,
  notExists,
  or,
  sql,
} from "drizzle-orm"
import { alias } from "drizzle-orm/sqlite-core"
import { DateTime, Effect, Layer } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import * as schema from "@pf/drizzle-sqlite"
import {
  ProcessCollectionQueries,
  type ProcessCollectionRow,
  type ProcessMetadataRow,
  ProcessQueries,
  type PullCheckpoint,
} from "@pf/graphql-db-operations"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"
import { retryTransientSqliteError } from "./transient-sqlite-error"

const queryStartStepId = (db: TypedSqliteDrizzle["Service"]) => {
  const startStep = alias(schema.step, "start_step")
  return db
    .select({ id: startStep.id })
    .from(startStep)
    .where(
      and(
        eq(startStep.processId, schema.process.id),
        eq(startStep._deleted, sql`0`),
        notExists(
          db
            .select({ id: schema.flow.id })
            .from(schema.flow)
            .where(
              and(
                eq(schema.flow.targetStepId, startStep.id),
                eq(schema.flow._deleted, sql`0`),
              ),
            ),
        ),
      ),
    )
    .limit(1)
}

/**
 * Live implementation of ProcessQueries service for SQLite.
 */
export const SqliteProcessQueriesLive = Layer.effect(
  ProcessQueries,
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle
    const startStepId = queryStartStepId(db)

    // Correlate on Process ID: Turso does not push the path filter into the grouped view.
    const activeInstanceCount = db
      .select({ count: countDistinct(schema.toDo.id) })
      .from(schema.processState)
      .innerJoin(
        schema.processExecution,
        eq(schema.processExecution.processStateId, schema.processState.id),
      )
      .innerJoin(
        schema.toDo,
        eq(schema.toDo.processExecutionId, schema.processExecution.id),
      )
      .where(
        and(
          eq(schema.processState.processId, schema.process.id),
          eq(schema.processState._deleted, sql`0`),
          eq(schema.processExecution._deleted, sql`0`),
          eq(schema.toDo._deleted, sql`0`),
        ),
      )

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
          const conditions = [eq(schema.process._deleted, sql`0`)]
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
              activeInstances: sql`(${activeInstanceCount})`.mapWith(Number),
            })
            .from(schema.process)
            .innerJoin(
              schema.orgUnit,
              eq(schema.process.orgUnitId, schema.orgUnit.id),
            )
            .innerJoin(schema.step, eq(schema.step.id, startStepId))
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

    const startStepId = queryStartStepId(db)

    const metadataFields = {
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
    }

    /**
     * Builds and executes the process query.
     * @param whereClause - The WHERE clause to apply (checkpoint filter or id filter)
     * @param limit - Optional limit for the query
     * @param ids - Constrain aggregate inputs for targeted document lookups
     */
    const queryProcesses = (
      whereClause: SQL | undefined,
      limit?: number,
      ids?: string[],
    ): Effect.Effect<ProcessCollectionRow[], SqlError> =>
      Effect.gen(function* () {
        // Keep the ID predicate inside each aggregate: Turso does not push the
        // outer Process filter through the grouped views/CTEs.
        const processStateFilter = and(
          ids === undefined
            ? undefined
            : inArray(schema.processState.processId, ids),
          eq(schema.processState._deleted, sql`0`),
          eq(schema.processExecution._deleted, sql`0`),
        )
        const activeProcesses = db.$with("active_processes").as(
          db
            .select({
              processId: schema.processState.processId,
              activeProcesses: countDistinct(schema.toDo.id).as(
                "active_processes",
              ),
            })
            .from(schema.processState)
            .innerJoin(
              schema.processExecution,
              eq(
                schema.processExecution.processStateId,
                schema.processState.id,
              ),
            )
            .innerJoin(
              schema.toDo,
              eq(schema.toDo.processExecutionId, schema.processExecution.id),
            )
            .where(and(processStateFilter, eq(schema.toDo._deleted, sql`0`)))
            .groupBy(schema.processState.processId),
        )
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
            .from(schema.processState)
            .innerJoin(
              schema.processExecution,
              eq(
                schema.processExecution.processStateId,
                schema.processState.id,
              ),
            )
            .where(
              and(
                isNotNull(schema.processExecution.finishedAt),
                processStateFilter,
              ),
            )
            .groupBy(schema.processState.processId),
        )

        const baseQuery = db
          .with(activeProcesses, durationStats)
          .select({
            ...metadataFields,
            activeInstances: activeProcesses.activeProcesses,
            minDurationMs: durationStats.minDurationMs,
            maxDurationMs: durationStats.maxDurationMs,
          })
          .from(schema.process)
          .innerJoin(
            schema.orgUnit,
            eq(schema.process.orgUnitId, schema.orgUnit.id),
          )
          .leftJoin(schema.step, eq(schema.step.id, startStepId))
          .leftJoin(
            activeProcesses,
            eq(schema.process.id, activeProcesses.processId),
          )
          .leftJoin(
            durationStats,
            eq(schema.process.id, durationStats.processId),
          )
          .where(whereClause)
          .orderBy(sql`updated_at_millis`, schema.process.id)

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
            startStepPath: row.startStepPath ?? "",
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
      advanceProcessRevision: (id) =>
        Effect.gen(function* () {
          const rows = yield* db
            .select({
              latest: sql<number>`CAST(ROUND((MAX(${schema.process.updatedAt}) - 2440587.5) * 86400000) AS INTEGER)`,
            })
            .from(schema.process)
          yield* db
            .update(schema.process)
            .set({
              updatedAt: DateTime.makeUnsafe(Number(rows[0]?.latest ?? 0) + 1),
            })
            .where(eq(schema.process.id, id))
        }),
      observeProcesses: (scope, ids) =>
        ids.length === 0
          ? Effect.void
          : db
              .insert(schema.processVisibility)
              .values(
                ids.map((processId) => ({
                  processId,
                  replicationScope: scope,
                })),
              )
              .onConflictDoNothing()
              .pipe(Effect.asVoid),
      getObservedProcessIds: (scope, ids) =>
        ids.length === 0
          ? Effect.succeed([])
          : db
              .select({ id: schema.processVisibility.processId })
              .from(schema.processVisibility)
              .where(
                and(
                  eq(schema.processVisibility.replicationScope, scope),
                  inArray(schema.processVisibility.processId, [...ids]),
                  eq(schema.processVisibility._deleted, sql`0`),
                ),
              )
              .pipe(Effect.map((rows) => rows.map((row) => row.id))),
      pullProcess: (
        checkpoint: PullCheckpoint | null | undefined,
        limit: number,
      ) => queryProcesses(buildCheckpointFilter(checkpoint), limit),

      getProcessMetadata: (ids: string[]) =>
        ids.length === 0
          ? Effect.succeed([])
          : db
              .select(metadataFields)
              .from(schema.process)
              .innerJoin(
                schema.orgUnit,
                eq(schema.process.orgUnitId, schema.orgUnit.id),
              )
              .leftJoin(schema.step, eq(schema.step.id, startStepId))
              .where(inArray(schema.process.id, ids))
              .orderBy(sql`updated_at_millis`, schema.process.id)
              .pipe(
                Effect.map((rows) =>
                  rows.map(
                    (row): ProcessMetadataRow => ({
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
                      startStepPath: row.startStepPath ?? "",
                      formFieldCount: row.formFieldCount ?? 0,
                    }),
                  ),
                ),
              ),

      getProcesses: (ids: string[]) =>
        ids.length === 0
          ? Effect.succeed([])
          : queryProcesses(inArray(schema.process.id, ids), undefined, ids),
    }
  }),
)
