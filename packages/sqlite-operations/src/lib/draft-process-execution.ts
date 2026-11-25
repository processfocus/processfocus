import { and, eq, gt, inArray, notExists, or, sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import * as schema from "@pf/drizzle-sqlite"
import {
  type DraftProcessExecutionMaster,
  DraftProcessExecutionQueries,
  type DraftProcessExecutionRow,
  type ProcessState,
  type PullCheckpoint,
  StepNotFoundError,
  UpdateDeletedDocumentError,
  type UserDetails,
  getUserDetails,
} from "@pf/graphql-db-operations"
import { getRequestTime } from "@pf/request-time"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"

const draftStateMatches = (state: ProcessState) => {
  const expectedJson = JSON.stringify(state)
  // Compare parsed values in both directions, independent of object key order.
  // Turso does not support EXCEPT in these correlated WHERE subqueries.
  return sql<boolean>`
    NOT EXISTS (
      SELECT 1 FROM json_tree(${schema.processState.state}) AS actual
      WHERE NOT EXISTS (
        SELECT 1 FROM json_tree(${expectedJson}) AS expected
        WHERE expected.fullkey = actual.fullkey
          AND expected.type = actual.type
          AND expected.atom IS actual.atom
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM json_tree(${expectedJson}) AS expected
      WHERE NOT EXISTS (
        SELECT 1 FROM json_tree(${schema.processState.state}) AS actual
        WHERE actual.fullkey = expected.fullkey
          AND actual.type = expected.type
          AND actual.atom IS expected.atom
      )
    )
  `
}

/**
 * Live implementation of DraftProcessExecutionQueries service for SQLite.
 *
 * Returns updatedAt as epoch milliseconds.
 */
export const SqliteDraftProcessExecutionQueriesLive = Layer.effect(
  DraftProcessExecutionQueries,
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle
    const isDraft = notExists(
      db
        .select({ one: sql`1` })
        .from(schema.processExecution)
        .where(
          and(
            eq(schema.processExecution.processStateId, schema.processState.id),
            eq(schema.processExecution._deleted, sql`0`),
          ),
        ),
    )

    return {
      pullDraftProcessExecution: (
        checkpoint: PullCheckpoint | null | undefined,
        limit: number,
      ): Effect.Effect<DraftProcessExecutionRow[], SqlError, UserDetails> =>
        Effect.gen(function* () {
          const userDetails = yield* getUserDetails()
          if (!userDetails.id) return []

          // Build WHERE conditions
          const conditions = [
            isDraft,
            eq(schema.processState.startedByUserId, userDetails.id),
          ]

          if (checkpoint) {
            const updatedAtMillis = sql<number>`CAST(ROUND((${schema.processState.updatedAt} - 2440587.5) * 86400000) AS INTEGER)`

            // Checkpoint filtering: (updatedAt > checkpoint) OR (updatedAt = checkpoint AND id > checkpoint.id)
            const checkpointFilter = or(
              gt(updatedAtMillis, checkpoint.updatedAt),
              and(
                eq(updatedAtMillis, checkpoint.updatedAt),
                gt(schema.processState.id, checkpoint.id),
              ),
            )
            if (checkpointFilter) {
              conditions.push(checkpointFilter)
            }
          }

          // Query with raw SQL conversion for updatedAt to avoid DateTime.Utc overhead
          const rows = yield* db
            .select({
              id: schema.processState.id,
              processId: schema.processState.processId,
              startStepId: schema.processState.startStepId,
              startedByUserId: schema.processState.startedByUserId,
              startedByEmail: schema.providerUser.email,
              name: schema.process.name,
              startStepPath: schema.step.path,
              state: schema.processState.state,
              lastSaved: schema.processState.updatedAt,
              updatedAt:
                sql<number>`CAST(ROUND((${schema.processState.updatedAt} - 2440587.5) * 86400000) AS INTEGER)`.as(
                  "updated_at_millis",
                ),
              deleted: schema.processState._deleted,
            })
            .from(schema.processState)
            .innerJoin(
              schema.process,
              eq(schema.processState.processId, schema.process.id),
            )
            .innerJoin(
              schema.step,
              eq(schema.processState.startStepId, schema.step.id),
            )
            .leftJoin(
              schema.providerUser,
              and(
                eq(
                  schema.processState.startedByUserId,
                  schema.providerUser.userId,
                ),
                eq(schema.providerUser._deleted, sql`0`),
              ),
            )
            .where(and(...conditions))
            .orderBy(schema.processState.updatedAt, schema.processState.id)
            .limit(limit)

          return rows.map((row) => ({
            ...row,
            state: row.state as ProcessState,
          }))
        }),

      insertProcessState: (
        processStateId: string,
        processId: string,
        startStepPath: string,
        state: ProcessState,
      ) =>
        Effect.gen(function* () {
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()

          // Look up the step by path to get its id
          const stepResult = yield* db
            .select({ id: schema.step.id })
            .from(schema.step)
            .where(
              and(
                eq(schema.step.path, startStepPath),
                eq(schema.step.processId, processId),
                eq(schema.step._deleted, false),
              ),
            )
            .limit(1)

          const stepRow = stepResult[0]
          if (!stepRow) {
            return yield* new StepNotFoundError({
              path: startStepPath,
              message: `Step not found for path: ${startStepPath}`,
            })
          }

          const inserted = yield* db
            .insert(schema.processState)
            .values({
              id: processStateId,
              processId,
              startStepId: stepRow.id,
              state: state,
              startedByUserId: userDetails.id,
              createdAt: requestTime,
              updatedAt: requestTime,
              createdBy: userDetails.by,
              updatedBy: userDetails.by,
            })
            .onConflictDoNothing({ target: schema.processState.id })
            .returning({ id: schema.processState.id })

          if (inserted.length === 0) {
            return yield* new UpdateDeletedDocumentError({
              processStateId,
              message: `Draft process execution already exists: ${processStateId}`,
            })
          }

          return processStateId
        }),

      updateProcessState: (
        processStateId: string,
        state: ProcessState,
        assumedMasterState: DraftProcessExecutionMaster,
      ) =>
        Effect.gen(function* () {
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()
          if (assumedMasterState.id !== processStateId) {
            return yield* new UpdateDeletedDocumentError({
              processStateId,
              message: "Assumed master state targets a different document",
            })
          }
          const userId = userDetails.id
          if (!userId) {
            return yield* new UpdateDeletedDocumentError({
              processStateId,
              message:
                "Draft process execution requires a persisted user owner",
            })
          }
          if (assumedMasterState.deleted) {
            return yield* new UpdateDeletedDocumentError({
              processStateId,
              message: `Cannot update deleted process execution state: ${processStateId}`,
            })
          }
          const persistedUpdatedAt = sql<number>`CAST(ROUND((${schema.processState.updatedAt} - 2440587.5) * 86400000) AS INTEGER)`

          const result = yield* db
            .update(schema.processState)
            .set({
              state: state,
              updatedAt: requestTime,
              updatedBy: userDetails.by,
              _deleted: false,
            })
            .where(
              and(
                eq(schema.processState.id, processStateId),
                eq(schema.processState.processId, assumedMasterState.processId),
                draftStateMatches(assumedMasterState.state),
                eq(schema.processState._deleted, false),
                eq(
                  persistedUpdatedAt,
                  Math.round(assumedMasterState.updatedAt),
                ),
                eq(schema.processState.startedByUserId, userId),
                isDraft,
              ),
            )
            .returning({ id: schema.processState.id })

          if (result.length === 0) {
            return yield* new UpdateDeletedDocumentError({
              processStateId,
              message: `Cannot update deleted process execution state: ${processStateId}`,
            })
          }

          return processStateId
        }),

      deleteProcessState: (
        processStateId: string,
        assumedMasterState: DraftProcessExecutionMaster,
      ) =>
        Effect.gen(function* () {
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()
          if (assumedMasterState.id !== processStateId) {
            return yield* new UpdateDeletedDocumentError({
              processStateId,
              message: "Assumed master state targets a different document",
            })
          }
          const userId = userDetails.id
          if (!userId) {
            return yield* new UpdateDeletedDocumentError({
              processStateId,
              message:
                "Draft process execution requires a persisted user owner",
            })
          }
          if (assumedMasterState.deleted) {
            return yield* new UpdateDeletedDocumentError({
              processStateId,
              message: `Cannot delete from a deleted assumed master state: ${processStateId}`,
            })
          }
          const persistedUpdatedAt = sql<number>`CAST(ROUND((${schema.processState.updatedAt} - 2440587.5) * 86400000) AS INTEGER)`

          const result = yield* db
            .update(schema.processState)
            .set({
              _deleted: true,
              updatedAt: requestTime,
              updatedBy: userDetails.by,
            })
            .where(
              and(
                eq(schema.processState.id, processStateId),
                eq(schema.processState.processId, assumedMasterState.processId),
                draftStateMatches(assumedMasterState.state),
                eq(schema.processState._deleted, false),
                eq(
                  persistedUpdatedAt,
                  Math.round(assumedMasterState.updatedAt),
                ),
                eq(schema.processState.startedByUserId, userId),
                isDraft,
              ),
            )
            .returning({ id: schema.processState.id })

          if (result.length === 0) {
            return yield* new UpdateDeletedDocumentError({
              processStateId,
              message: `Cannot delete inaccessible, changed, or non-draft process execution state: ${processStateId}`,
            })
          }

          return processStateId
        }),

      getProcessStates: (
        processStateIds: string[],
      ): Effect.Effect<DraftProcessExecutionRow[], SqlError, UserDetails> =>
        Effect.gen(function* () {
          const userDetails = yield* getUserDetails()
          if (!userDetails.id || processStateIds.length === 0) return []

          // Query with raw SQL conversion for updatedAt to avoid DateTime.Utc overhead
          const rows = yield* db
            .select({
              id: schema.processState.id,
              processId: schema.processState.processId,
              startStepId: schema.processState.startStepId,
              startedByUserId: schema.processState.startedByUserId,
              startedByEmail: schema.providerUser.email,
              name: schema.process.name,
              startStepPath: schema.step.path,
              state: schema.processState.state,
              lastSaved: schema.processState.updatedAt,
              updatedAt:
                sql<number>`CAST(ROUND((${schema.processState.updatedAt} - 2440587.5) * 86400000) AS INTEGER)`.as(
                  "updated_at_millis",
                ),
              deleted: schema.processState._deleted,
            })
            .from(schema.processState)
            .innerJoin(
              schema.process,
              eq(schema.processState.processId, schema.process.id),
            )
            .innerJoin(
              schema.step,
              eq(schema.processState.startStepId, schema.step.id),
            )
            .leftJoin(
              schema.providerUser,
              and(
                eq(
                  schema.processState.startedByUserId,
                  schema.providerUser.userId,
                ),
                eq(schema.providerUser._deleted, sql`0`),
              ),
            )
            .where(
              and(
                inArray(schema.processState.id, processStateIds),
                isDraft,
                eq(schema.processState.startedByUserId, userDetails.id),
              ),
            )
            .orderBy(schema.processState.updatedAt, schema.processState.id)

          return rows.map((row) => ({
            ...row,
            state: row.state as ProcessState,
          }))
        }),
    }
  }),
)
