import { aliasedTable, and, eq, isNull } from "drizzle-orm"
import { Effect, Layer, Option } from "effect"
import * as schema from "@pf/drizzle-sqlite"
import {
  type InsertScheduledFlowOptions,
  ScheduledFlowOperations,
  getUserDetails,
  returnedRow,
} from "@pf/graphql-db-operations"
import { getRequestTime } from "@pf/request-time"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"

/**
 * Live implementation of ScheduledFlowOperations service for SQLite.
 *
 * Contains only database operations without business logic.
 */
export const SqliteScheduledFlowOperationsLive = Layer.effect(
  ScheduledFlowOperations,
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle
    const sourceStep = aliasedTable(schema.step, "source_step")
    const targetStep = aliasedTable(schema.step, "target_step")

    return {
      insertScheduledFlow: (
        processExecutionId: string,
        sourceStepId: string,
        options?: InsertScheduledFlowOptions,
      ) =>
        Effect.gen(function* () {
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()

          const result = yield* db
            .insert(schema.scheduledFlow)
            .values({
              processExecutionId,
              sourceStepId,
              targetStepId: options?.targetStepId,
              scheduledAt: options?.scheduledAt,
              forEachBarrier: options?.forEachBarrier ?? false,
              completedByRoleId: options?.completedByRoleId,
              createdAt: requestTime,
              updatedAt: requestTime,
              createdBy: userDetails.by,
              updatedBy: userDetails.by,
            })
            .returning({ id: schema.scheduledFlow.id })

          return (yield* returnedRow(result)).id
        }),

      insertOrGetScheduledFlow: (
        id: string,
        processExecutionId: string,
        sourceStepId: string,
        options?: InsertScheduledFlowOptions,
      ) =>
        Effect.gen(function* () {
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()
          const inserted = yield* db
            .insert(schema.scheduledFlow)
            .values({
              id,
              processExecutionId,
              sourceStepId,
              targetStepId: options?.targetStepId,
              scheduledAt: options?.scheduledAt,
              forEachBarrier: options?.forEachBarrier ?? false,
              completedByRoleId: options?.completedByRoleId,
              createdAt: requestTime,
              updatedAt: requestTime,
              createdBy: userDetails.by,
              updatedBy: userDetails.by,
            })
            .onConflictDoNothing({ target: schema.scheduledFlow.id })
            .returning({ id: schema.scheduledFlow.id })

          if (inserted[0]) return inserted[0].id
          const existing = yield* db
            .select({ id: schema.scheduledFlow.id })
            .from(schema.scheduledFlow)
            .where(eq(schema.scheduledFlow.id, id))
            .limit(1)
          return (yield* returnedRow(existing)).id
        }),

      getScheduledFlow: (id: string) =>
        Effect.gen(function* () {
          const result = yield* db
            .select({
              processExecutionId: schema.scheduledFlow.processExecutionId,
              createdBy: schema.scheduledFlow.createdBy,
              sourceStepId: schema.scheduledFlow.sourceStepId,
              targetStepId: schema.scheduledFlow.targetStepId,
              scheduledAt: schema.scheduledFlow.scheduledAt,
              forEachBarrier: schema.scheduledFlow.forEachBarrier,
              completedByRoleId: schema.scheduledFlow.completedByRoleId,
            })
            .from(schema.scheduledFlow)
            .where(eq(schema.scheduledFlow.id, id))
            .limit(1)

          if (!result[0]) {
            return Option.none()
          }

          return Option.some({
            processExecutionId: result[0].processExecutionId,
            createdBy: result[0].createdBy,
            sourceStepId: result[0].sourceStepId,
            targetStepId: result[0].targetStepId,
            scheduledAt: result[0].scheduledAt,
            forEachBarrier: result[0].forEachBarrier,
            completedByRoleId: result[0].completedByRoleId,
          })
        }),

      deleteScheduledFlow: (id: string) =>
        Effect.gen(function* () {
          const result = yield* db
            .delete(schema.scheduledFlow)
            .where(eq(schema.scheduledFlow.id, id))
            .returning({ id: schema.scheduledFlow.id })
          return result.length > 0
        }),

      hasPendingScheduledFlows: (processExecutionId: string) =>
        Effect.gen(function* () {
          // Check for pending scheduled flows
          const pendingFlows = yield* db
            .select({ id: schema.scheduledFlow.id })
            .from(schema.scheduledFlow)
            .where(
              eq(schema.scheduledFlow.processExecutionId, processExecutionId),
            )
            .limit(1)

          if (pendingFlows.length > 0) return true

          // Check for active system step todos (steps with no role).
          // These will create new scheduled flows when they complete,
          // so the process still has pending async work.
          const activeSystemTodos = yield* db
            .select({ id: schema.toDo.id })
            .from(schema.toDo)
            .innerJoin(schema.flow, eq(schema.toDo.flowId, schema.flow.id))
            .innerJoin(
              schema.step,
              eq(schema.flow.targetStepId, schema.step.id),
            )
            .where(
              and(
                eq(schema.toDo.processExecutionId, processExecutionId),
                isNull(schema.toDo.businessDuration),
                isNull(schema.toDo.failureReason),
                eq(schema.toDo._deleted, false),
                isNull(schema.step.roleId),
              ),
            )
            .limit(1)

          return activeSystemTodos.length > 0
        }),

      getPendingStartScheduledFlowId: (
        processExecutionId: string,
        sourceStepId: string,
      ) =>
        Effect.gen(function* () {
          const result = yield* db
            .select({ id: schema.scheduledFlow.id })
            .from(schema.scheduledFlow)
            .where(
              and(
                eq(schema.scheduledFlow.processExecutionId, processExecutionId),
                eq(schema.scheduledFlow.sourceStepId, sourceStepId),
                isNull(schema.scheduledFlow.targetStepId),
                isNull(schema.scheduledFlow.scheduledAt),
                eq(schema.scheduledFlow.forEachBarrier, false),
              ),
            )
            .limit(1)

          return result[0]?.id ?? null
        }),

      queryPendingAbandonStepPaths: (processExecutionId: string) =>
        Effect.gen(function* () {
          const rows: ReadonlyArray<{
            readonly sourceStepPath: string
            readonly targetStepPath: string | null
          }> = yield* db
            .select({
              sourceStepPath: sourceStep.path,
              targetStepPath: targetStep.path,
            })
            .from(schema.scheduledFlow)
            .innerJoin(
              sourceStep,
              and(
                eq(schema.scheduledFlow.sourceStepId, sourceStep.id),
                eq(sourceStep._deleted, false),
              ),
            )
            .leftJoin(
              targetStep,
              and(
                eq(schema.scheduledFlow.targetStepId, targetStep.id),
                eq(targetStep._deleted, false),
              ),
            )
            .where(
              and(
                eq(schema.scheduledFlow.processExecutionId, processExecutionId),
                eq(schema.scheduledFlow._deleted, false),
              ),
            )

          return [
            ...new Set(
              rows.map((row) => row.targetStepPath ?? row.sourceStepPath),
            ),
          ]
        }),

      deleteScheduledFlowsForExecution: (processExecutionId: string) =>
        Effect.gen(function* () {
          yield* db
            .delete(schema.scheduledFlow)
            .where(
              eq(schema.scheduledFlow.processExecutionId, processExecutionId),
            )
        }),

      wasBarrierScheduledFlow: (scheduledFlowId: string) =>
        Effect.gen(function* () {
          const result = yield* db
            .select({ id: schema.toDo.id })
            .from(schema.toDo)
            .where(eq(schema.toDo.barrierScheduledFlowId, scheduledFlowId))
            .limit(1)

          return result.length > 0
        }),
    }
  }),
)
