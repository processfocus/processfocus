import { aliasedTable, and, eq, isNull } from "drizzle-orm"
import { Effect, Layer, Option } from "effect"
import * as schema from "@pf/drizzle-postgres"
import {
  type InsertScheduledFlowOptions,
  ScheduledFlowOperations,
  getUserDetails,
  returnedRow,
} from "@pf/graphql-db-operations"
import { getRequestTime } from "@pf/request-time"
import { TypedPostgresDrizzle } from "@pf/service-drizzle-postgres"

/**
 * Live implementation of ScheduledFlowOperations service for PostgreSQL.
 *
 * Contains only database operations without business logic.
 */
export const PostgresScheduledFlowOperationsLive = Layer.effect(
  ScheduledFlowOperations,
  Effect.gen(function* () {
    const db = yield* TypedPostgresDrizzle
    const sourceStep = aliasedTable(schema.step, "source_step")
    const targetStep = aliasedTable(schema.step, "target_step")

    return {
      queryPendingTaskDeadlines: (processExecutionId: string) =>
        db
          .select({
            id: schema.taskDeadline.id,
            scheduledAt: schema.taskDeadline.scheduledAt,
            withoutWaiting: schema.processExecution.withoutWaiting,
          })
          .from(schema.taskDeadline)
          .innerJoin(
            schema.toDo,
            eq(schema.taskDeadline.ownerToDoId, schema.toDo.id),
          )
          .innerJoin(
            schema.processExecution,
            eq(schema.toDo.processExecutionId, schema.processExecution.id),
          )
          .innerJoin(
            schema.scheduledFlow,
            eq(schema.taskDeadline.id, schema.scheduledFlow.id),
          )
          .where(
            and(
              eq(schema.toDo.processExecutionId, processExecutionId),
              eq(schema.toDo._deleted, false),
              isNull(schema.taskDeadline.triggeredAt),
              isNull(schema.taskDeadline.disarmedAt),
            ),
          ),

      hasTaskDeadlines: (processExecutionId: string) =>
        Effect.gen(function* () {
          const rows = yield* db
            .select({ id: schema.taskDeadline.id })
            .from(schema.taskDeadline)
            .innerJoin(
              schema.toDo,
              eq(schema.taskDeadline.ownerToDoId, schema.toDo.id),
            )
            .where(eq(schema.toDo.processExecutionId, processExecutionId))
            .limit(1)
          return rows.length > 0
        }),

      insertTaskDeadline: (input) =>
        Effect.gen(function* () {
          const now = yield* getRequestTime()
          const user = yield* getUserDetails()
          const rows = yield* db
            .insert(schema.taskDeadline)
            .values({
              ownerToDoId: input.ownerTodoId,
              flowId: input.flowId,
              deadlineName: input.name,
              scheduledAt: input.dueAt,
              interrupting: input.interrupting,
              createdAt: now,
              updatedAt: now,
              createdBy: user.by,
              updatedBy: user.by,
            })
            .returning({ id: schema.taskDeadline.id })
          return (yield* returnedRow(rows)).id
        }),

      getTaskDeadline: (id) =>
        Effect.gen(function* () {
          const rows = yield* db
            .select({
              ownerTodoId: schema.taskDeadline.ownerToDoId,
              flowId: schema.taskDeadline.flowId,
              dueAt: schema.taskDeadline.scheduledAt,
              interrupting: schema.taskDeadline.interrupting,
              triggeredAt: schema.taskDeadline.triggeredAt,
              disarmedAt: schema.taskDeadline.disarmedAt,
            })
            .from(schema.taskDeadline)
            .where(eq(schema.taskDeadline.id, id))
          return rows[0] ?? null
        }),

      claimTaskDeadline: (id, ownerTodoId) =>
        Effect.gen(function* () {
          // Lock the same owner row completion writes before deciding the deadline.
          const owners = yield* db
            .update(schema.toDo)
            .set({ updatedAt: schema.toDo.updatedAt })
            .where(
              and(
                eq(schema.toDo.id, ownerTodoId),
                eq(schema.toDo._deleted, false),
                isNull(schema.toDo.failureReason),
              ),
            )
            .returning({ id: schema.toDo.id })
          if (owners.length === 0) return false
          const now = yield* getRequestTime()
          const user = yield* getUserDetails()
          const rows = yield* db
            .update(schema.taskDeadline)
            .set({ triggeredAt: now, updatedAt: now, updatedBy: user.by })
            .where(
              and(
                eq(schema.taskDeadline.id, id),
                isNull(schema.taskDeadline.triggeredAt),
                isNull(schema.taskDeadline.disarmedAt),
              ),
            )
            .returning({ id: schema.taskDeadline.id })
          return rows.length === 1
        }),

      interruptTask: (ownerTodoId) =>
        Effect.gen(function* () {
          const now = yield* getRequestTime()
          const user = yield* getUserDetails()
          yield* db
            .update(schema.toDo)
            .set({
              _deleted: true,
              interruptedAt: now,
              correctionRequiredAt: null,
              correctionFailureReason: null,
              correctionInvitationAttemptId: null,
              updatedAt: now,
              updatedBy: user.by,
            })
            .where(eq(schema.toDo.id, ownerTodoId))
        }),

      disarmTaskDeadlines: (ownerTodoId) =>
        Effect.gen(function* () {
          const now = yield* getRequestTime()
          const user = yield* getUserDetails()
          const rows = yield* db
            .update(schema.taskDeadline)
            .set({ disarmedAt: now, updatedAt: now, updatedBy: user.by })
            .where(
              and(
                eq(schema.taskDeadline.ownerToDoId, ownerTodoId),
                isNull(schema.taskDeadline.triggeredAt),
                isNull(schema.taskDeadline.disarmedAt),
              ),
            )
            .returning({ id: schema.taskDeadline.id })
          for (const row of rows) {
            yield* db
              .delete(schema.scheduledFlow)
              .where(eq(schema.scheduledFlow.id, row.id))
          }
        }),

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
