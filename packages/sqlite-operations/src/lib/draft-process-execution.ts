import type { SqlError } from "@effect/sql/SqlError"
import { and, eq, gt, inArray, or, sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
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

/**
 * Live implementation of DraftProcessExecutionQueries service for SQLite.
 *
 * Returns updatedAt as epoch milliseconds.
 */
export const SqliteDraftProcessExecutionQueriesLive = Layer.effect(
  DraftProcessExecutionQueries,
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle

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
            eq(schema.processStateItsIsDraft.isDraft, true),
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
            .innerJoin(
              schema.processStateItsIsDraft,
              eq(schema.processState.id, schema.processStateItsIsDraft.id),
            )
            .leftJoin(
              schema.providerUser,
              and(
                eq(
                  schema.processState.startedByUserId,
                  schema.providerUser.userId,
                ),
                eq(schema.providerUser._deleted, false),
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
          const assumedStateJson = JSON.stringify(assumedMasterState.state)
          const persistedStateMatches = sql<boolean>`
            NOT EXISTS (
              SELECT fullkey, atom, type FROM json_tree(${schema.processState.state})
              EXCEPT
              SELECT fullkey, atom, type FROM json_tree(${assumedStateJson})
            )
            AND NOT EXISTS (
              SELECT fullkey, atom, type FROM json_tree(${assumedStateJson})
              EXCEPT
              SELECT fullkey, atom, type FROM json_tree(${schema.processState.state})
            )
          `

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
                persistedStateMatches,
                eq(schema.processState._deleted, false),
                eq(
                  persistedUpdatedAt,
                  Math.round(assumedMasterState.updatedAt),
                ),
                eq(schema.processState.startedByUserId, userId),
                inArray(
                  schema.processState.id,
                  db
                    .select({ id: schema.processStateItsIsDraft.id })
                    .from(schema.processStateItsIsDraft)
                    .where(eq(schema.processStateItsIsDraft.isDraft, true)),
                ),
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
          const assumedStateJson = JSON.stringify(assumedMasterState.state)
          const persistedStateMatches = sql<boolean>`
            NOT EXISTS (
              SELECT fullkey, atom, type FROM json_tree(${schema.processState.state})
              EXCEPT
              SELECT fullkey, atom, type FROM json_tree(${assumedStateJson})
            )
            AND NOT EXISTS (
              SELECT fullkey, atom, type FROM json_tree(${assumedStateJson})
              EXCEPT
              SELECT fullkey, atom, type FROM json_tree(${schema.processState.state})
            )
          `

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
                persistedStateMatches,
                eq(schema.processState._deleted, false),
                eq(
                  persistedUpdatedAt,
                  Math.round(assumedMasterState.updatedAt),
                ),
                eq(schema.processState.startedByUserId, userId),
                inArray(
                  schema.processState.id,
                  db
                    .select({ id: schema.processStateItsIsDraft.id })
                    .from(schema.processStateItsIsDraft)
                    .where(eq(schema.processStateItsIsDraft.isDraft, true)),
                ),
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
            .innerJoin(
              schema.processStateItsIsDraft,
              eq(schema.processState.id, schema.processStateItsIsDraft.id),
            )
            .leftJoin(
              schema.providerUser,
              and(
                eq(
                  schema.processState.startedByUserId,
                  schema.providerUser.userId,
                ),
                eq(schema.providerUser._deleted, false),
              ),
            )
            .where(
              and(
                inArray(schema.processState.id, processStateIds),
                eq(schema.processStateItsIsDraft.isDraft, true),
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
