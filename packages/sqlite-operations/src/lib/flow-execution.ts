import {
  aliasedTable,
  and,
  eq,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm"
import { Effect, Layer } from "effect"
import * as schema from "@pf/drizzle-sqlite"
import {
  type FlowDispatchJob,
  FlowExecutionOperations,
  type FlowWithCondition,
  getUserDetails,
  mapNotificationRecipientRow,
  normalizeTaggedErrors,
  returnedRow,
} from "@pf/graphql-db-operations"
import { getRequestTime } from "@pf/request-time"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"

/**
 * Live implementation of FlowExecutionOperations service for SQLite.
 *
 * Contains only database operations without business logic.
 */
export const SqliteFlowExecutionOperationsLive = Layer.effect(
  FlowExecutionOperations,
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle

    // Create table aliases for joining step table twice
    const sourceStep = aliasedTable(schema.step, "source_step")
    const targetStep = aliasedTable(schema.step, "target_step")

    return {
      queryFlowById: (flowId: string) =>
        Effect.gen(function* () {
          const result = yield* db
            .select({
              id: schema.flow.id,
              condition: schema.flow.condition,
              schedule: schema.flow.schedule,
              sourceStepPath: sourceStep.path,
              targetStepId: targetStep.id,
              targetStepPath: targetStep.path,
              fallbackBranch: schema.flow.fallbackBranch,
              isOnError: schema.flow.errorBranch,
              taggedErrors: schema.flow.errorTags,
            })
            .from(schema.flow)
            .innerJoin(sourceStep, eq(schema.flow.sourceStepId, sourceStep.id))
            .innerJoin(targetStep, eq(schema.flow.targetStepId, targetStep.id))
            .where(
              and(eq(schema.flow.id, flowId), eq(schema.flow._deleted, false)),
            )
            .limit(1)

          const flow = result[0]
          if (!flow) {
            return null
          }

          return {
            ...flow,
            taggedErrors: normalizeTaggedErrors(flow.taggedErrors),
          } satisfies FlowWithCondition
        }),

      getProcessStateByExecutionId: (processExecutionId: string) =>
        Effect.gen(function* () {
          const result = yield* db
            .select({
              processStateId: schema.processState.id,
              withoutWaiting: schema.processExecution.withoutWaiting,
              createdBy: schema.processExecution.createdBy,
              state: schema.processState.state,
            })
            .from(schema.processExecution)
            .innerJoin(
              schema.processState,
              eq(
                schema.processExecution.processStateId,
                schema.processState.id,
              ),
            )
            .where(eq(schema.processExecution.id, processExecutionId))
            .limit(1)

          if (!result[0]) {
            return null
          }

          return {
            processStateId: result[0].processStateId,
            withoutWaiting: result[0].withoutWaiting,
            createdBy: result[0].createdBy,
            state: result[0].state,
          }
        }),

      isProcessExecutionOpen: (processExecutionId: string) =>
        Effect.gen(function* () {
          const result = yield* db
            .select({ id: schema.processExecution.id })
            .from(schema.processExecution)
            .where(
              and(
                eq(schema.processExecution.id, processExecutionId),
                isNull(schema.processExecution.finishedAt),
                isNull(schema.processExecution.abandonedAt),
              ),
            )
            .limit(1)

          return result.length > 0
        }),

      queryTodoNotificationInfo: (todoIds: readonly string[]) =>
        Effect.gen(function* () {
          if (todoIds.length === 0) {
            return []
          }

          return yield* db
            .select({
              todoId: schema.toDo.id,
              processExecutionId: schema.toDo.processExecutionId,
              assignedToProviderUserId: schema.toDo.assignedToProviderUserId,
              roleId: schema.step.roleId,
              stepPath: schema.step.path,
              processName: schema.process.name,
              stepName: schema.step.name,
              itemData: schema.toDo.itemData,
            })
            .from(schema.toDo)
            .innerJoin(schema.flow, eq(schema.toDo.flowId, schema.flow.id))
            .innerJoin(
              schema.step,
              eq(schema.flow.targetStepId, schema.step.id),
            )
            .innerJoin(
              schema.process,
              eq(schema.step.processId, schema.process.id),
            )
            .where(
              and(
                inArray(schema.toDo.id, todoIds),
                eq(schema.toDo._deleted, false),
                eq(schema.flow._deleted, false),
                eq(schema.step._deleted, false),
                eq(schema.process._deleted, false),
              ),
            )
        }),

      insertToDo: ({
        processExecutionId,
        flowId,
        assignedToProviderUserId,
        slaTargetAt,
        slaWarningAt,
        itemData,
        barrierScheduledFlowId,
      }) =>
        Effect.gen(function* () {
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()

          // Insert the todo and return the ID
          const insertResult = yield* db
            .insert(schema.toDo)
            .values({
              processExecutionId,
              flowId,
              assignedToProviderUserId: assignedToProviderUserId ?? null,
              slaTargetAt: slaTargetAt ?? null,
              slaWarningAt: slaWarningAt ?? null,
              itemData: itemData ?? null,
              barrierScheduledFlowId: barrierScheduledFlowId ?? null,
              createdAt: requestTime,
              updatedAt: requestTime,
              createdBy: userDetails.by,
              updatedBy: userDetails.by,
            })
            .returning({ id: schema.toDo.id })

          return (yield* returnedRow(insertResult)).id
        }),

      insertToDos: ({
        processExecutionId,
        flowId,
        items,
        slaTargetAt,
        slaWarningAt,
        barrierScheduledFlowId,
      }) =>
        Effect.gen(function* () {
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()

          const insertResult = yield* db
            .insert(schema.toDo)
            .values(
              items.map((itemData) => ({
                processExecutionId,
                flowId,
                slaTargetAt: slaTargetAt ?? null,
                slaWarningAt: slaWarningAt ?? null,
                itemData,
                barrierScheduledFlowId: barrierScheduledFlowId ?? null,
                createdAt: requestTime,
                updatedAt: requestTime,
                createdBy: userDetails.by,
                updatedBy: userDetails.by,
              })),
            )
            .returning({ id: schema.toDo.id })

          return insertResult.map((row) => row.id)
        }),

      queryFlowsBySourceStepId: (sourceStepId: string) =>
        Effect.gen(function* () {
          const result = yield* db
            .select({
              id: schema.flow.id,
              condition: schema.flow.condition,
              schedule: schema.flow.schedule,
              sourceStepPath: sourceStep.path,
              targetStepId: targetStep.id,
              targetStepPath: targetStep.path,
              fallbackBranch: schema.flow.fallbackBranch,
              isOnError: schema.flow.errorBranch,
              taggedErrors: schema.flow.errorTags,
            })
            .from(schema.flow)
            .innerJoin(sourceStep, eq(schema.flow.sourceStepId, sourceStep.id))
            .innerJoin(targetStep, eq(schema.flow.targetStepId, targetStep.id))
            .where(
              and(
                eq(schema.flow.sourceStepId, sourceStepId),
                eq(schema.flow._deleted, false),
              ),
            )

          return result.map((flow) => ({
            ...flow,
            taggedErrors: normalizeTaggedErrors(flow.taggedErrors),
          })) satisfies readonly FlowWithCondition[]
        }),

      countActiveTodos: (processExecutionId: string) =>
        Effect.gen(function* () {
          const result = yield* db
            .select({ count: sql<number>`COUNT(*)`.as("count") })
            .from(schema.toDo)
            .where(
              and(
                eq(schema.toDo.processExecutionId, processExecutionId),
                eq(schema.toDo._deleted, false),
              ),
            )
          return Number(result[0]?.count ?? 0)
        }),

      countPendingFlowJobs: (processExecutionId: string, queueName: string) =>
        Effect.gen(function* () {
          const result = yield* db
            .select({ count: sql<number>`COUNT(*)`.as("count") })
            .from(schema.jobQueue)
            .where(
              and(
                eq(schema.jobQueue.queue, queueName),
                eq(schema.jobQueue._deleted, false),
                sql`(
                  (
                    json_extract(${schema.jobQueue.jobPayload}, '$.sourceScheduledFlowId') IS NULL
                    AND json_extract(${schema.jobQueue.jobPayload}, '$.processExecutionId') = ${processExecutionId}
                  )
                  OR
                  (
                    json_extract(${schema.jobQueue.jobPayload}, '$.sourceScheduledFlowId') IS NOT NULL
                    AND json_extract(${schema.jobQueue.jobPayload}, '$.processExecutionId') = ${processExecutionId}
                    AND EXISTS (
                      SELECT 1 FROM ${schema.scheduledFlow}
                      WHERE ${schema.scheduledFlow.id} = json_extract(${schema.jobQueue.jobPayload}, '$.payload.scheduledFlowId')
                        AND ${schema.scheduledFlow._deleted} = false
                    )
                  )
                )`,
              ),
            )
          return Number(result[0]?.count ?? 0)
        }),

      insertFlowDispatchJobs: (jobs) =>
        Effect.gen(function* () {
          if (jobs.length === 0) return
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()
          // These rows are an outbox only when the runtime uses an external
          // queue; a DB-backed queue must never poll the same table concurrently.
          yield* db.insert(schema.jobQueue).values(
            jobs.map(
              ({
                sourceScheduledFlowId,
                processExecutionId,
                storageQueue,
                ...job
              }) => ({
                queue: storageQueue ?? job.queue,
                jobPayload: {
                  sourceScheduledFlowId,
                  ...(processExecutionId === undefined
                    ? {}
                    : { processExecutionId }),
                  ...job,
                },
                createdAt: requestTime,
                updatedAt: requestTime,
                createdBy: userDetails.by,
                updatedBy: userDetails.by,
              }),
            ),
          )
        }),

      queryFlowDispatchJobs: (sourceScheduledFlowId) =>
        Effect.gen(function* () {
          const rows = yield* db
            .select({
              id: schema.jobQueue.id,
              payload: schema.jobQueue.jobPayload,
            })
            .from(schema.jobQueue)
            .where(
              and(
                eq(schema.jobQueue._deleted, false),
                sql`json_extract(${schema.jobQueue.jobPayload}, '$.sourceScheduledFlowId') = ${sourceScheduledFlowId}`,
              ),
            )
          return rows
            .map(({ id, payload }) => ({
              id,
              ...(payload as Omit<FlowDispatchJob, "id">),
            }))
            .sort((left, right) => left.sequence - right.sequence)
        }),

      queryFlowDispatchIdsByStorageQueue: (storageQueue, now, limit) =>
        Effect.gen(function* () {
          const sourceScheduledFlowId = sql<string>`json_extract(${schema.jobQueue.jobPayload}, '$.sourceScheduledFlowId')`
          const rows = yield* db
            .select({ sourceScheduledFlowId })
            .from(schema.jobQueue)
            .where(
              and(
                eq(schema.jobQueue._deleted, false),
                eq(schema.jobQueue.queue, storageQueue),
                or(
                  isNull(schema.jobQueue.lockedUntil),
                  lte(schema.jobQueue.lockedUntil, now),
                ),
              ),
            )
            .groupBy(sourceScheduledFlowId)
            .orderBy(
              sql`MIN(${schema.jobQueue.createdAt})`,
              sourceScheduledFlowId,
            )
            .limit(limit)
          return rows.map((row) => row.sourceScheduledFlowId)
        }),

      claimFlowDispatchJobs: (
        sourceScheduledFlowId,
        now,
        lockedUntil,
        receipt,
      ) =>
        Effect.gen(function* () {
          const rows = yield* db
            .update(schema.jobQueue)
            .set({ lockedUntil, claimReceipt: receipt })
            .where(
              and(
                eq(schema.jobQueue._deleted, false),
                sql`json_extract(${schema.jobQueue.jobPayload}, '$.sourceScheduledFlowId') = ${sourceScheduledFlowId}`,
                or(
                  isNull(schema.jobQueue.lockedUntil),
                  lte(schema.jobQueue.lockedUntil, now),
                ),
              ),
            )
            .returning({
              id: schema.jobQueue.id,
              payload: schema.jobQueue.jobPayload,
            })
          return rows
            .map(({ id, payload }) => ({
              id,
              ...(payload as Omit<FlowDispatchJob, "id">),
            }))
            .sort((left, right) => left.sequence - right.sequence)
        }),

      releaseFlowDispatchJobs: (sourceScheduledFlowId, receipt) =>
        db
          .update(schema.jobQueue)
          .set({ lockedUntil: null, claimReceipt: null })
          .where(
            and(
              eq(schema.jobQueue._deleted, false),
              eq(schema.jobQueue.claimReceipt, receipt),
              sql`json_extract(${schema.jobQueue.jobPayload}, '$.sourceScheduledFlowId') = ${sourceScheduledFlowId}`,
            ),
          ),

      extendFlowDispatchClaim: (sourceScheduledFlowId, receipt, lockedUntil) =>
        Effect.gen(function* () {
          const rows = yield* db
            .update(schema.jobQueue)
            .set({ lockedUntil })
            .where(
              and(
                eq(schema.jobQueue._deleted, false),
                eq(schema.jobQueue.claimReceipt, receipt),
                sql`json_extract(${schema.jobQueue.jobPayload}, '$.sourceScheduledFlowId') = ${sourceScheduledFlowId}`,
              ),
            )
            .returning({ id: schema.jobQueue.id })
          return rows.length > 0
        }),

      deleteFlowDispatchJob: (id, receipt) =>
        Effect.gen(function* () {
          const rows = yield* db
            .delete(schema.jobQueue)
            .where(
              receipt === undefined
                ? eq(schema.jobQueue.id, id)
                : and(
                    eq(schema.jobQueue.id, id),
                    eq(schema.jobQueue.claimReceipt, receipt),
                  ),
            )
            .returning({ id: schema.jobQueue.id })
          return rows.length > 0
        }),

      setProcessExecutionFinished: (
        processExecutionId: string,
        businessDurationMs: number | null,
      ) =>
        Effect.gen(function* () {
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()
          yield* db
            .update(schema.processExecution)
            .set({
              finishedAt: requestTime,
              businessDuration: businessDurationMs,
              updatedAt: requestTime,
              updatedBy: userDetails.by,
            })
            .where(eq(schema.processExecution.id, processExecutionId))
        }),

      setProcessExecutionFailed: (
        processExecutionId: string,
        failureReason: string,
      ) =>
        Effect.gen(function* () {
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()
          yield* db
            .update(schema.processExecution)
            .set({
              finishedAt: requestTime,
              // Keep abandonedAt empty: this is a failed run, not a user cancellation.
              abandonedReason: failureReason,
              // An admitted attempt's failure supersedes a duplicate refusal.
              // The refused delivery remains recorded in notStartedJob.
              notStartedReason: null,
              updatedAt: requestTime,
              updatedBy: userDetails.by,
            })
            .where(
              and(
                eq(schema.processExecution.id, processExecutionId),
                isNull(schema.processExecution.finishedAt),
                isNull(schema.processExecution.abandonedAt),
              ),
            )
        }),

      getProcessIdForExecution: (processExecutionId: string) =>
        Effect.gen(function* () {
          const result = yield* db
            .select({
              processId: schema.processState.processId,
            })
            .from(schema.processExecution)
            .innerJoin(
              schema.processState,
              eq(
                schema.processExecution.processStateId,
                schema.processState.id,
              ),
            )
            .where(eq(schema.processExecution.id, processExecutionId))
            .limit(1)

          return result[0]?.processId ?? null
        }),

      getExecutionDetailsForCompletion: (processExecutionId: string) =>
        Effect.gen(function* () {
          const result = yield* db
            .select({
              // SQLite: Convert Julian day to epoch milliseconds
              createdAtMs:
                sql<number>`(${schema.processExecution.createdAt} - 2440587.5) * 86400000`.as(
                  "created_at_ms",
                ),
              orgUnitId: schema.process.orgUnitId,
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
            .where(eq(schema.processExecution.id, processExecutionId))
            .limit(1)

          return result[0] ?? null
        }),

      getTargetStepSlaInfo: (flowId: string) =>
        Effect.gen(function* () {
          const result = yield* db
            .select({
              slaValue: targetStep.slaValue,
              slaUnit: targetStep.slaUnit,
              slaWarning: targetStep.slaWarning,
              orgUnitId: schema.process.orgUnitId,
            })
            .from(schema.flow)
            .innerJoin(targetStep, eq(schema.flow.targetStepId, targetStep.id))
            .innerJoin(
              schema.process,
              eq(targetStep.processId, schema.process.id),
            )
            .where(
              and(eq(schema.flow.id, flowId), eq(schema.flow._deleted, false)),
            )
            .limit(1)

          return result[0] ?? null
        }),

      targetStepHasRole: (flowId: string) =>
        Effect.gen(function* () {
          const result = yield* db
            .select({
              roleId: targetStep.roleId,
            })
            .from(schema.flow)
            .innerJoin(targetStep, eq(schema.flow.targetStepId, targetStep.id))
            .where(
              and(eq(schema.flow.id, flowId), eq(schema.flow._deleted, false)),
            )
            .limit(1)

          if (!result[0]) {
            return null // Flow not found
          }

          // If roleId is not null, the step has a role
          return result[0].roleId !== null
        }),

      targetStepHasForEach: (flowId: string) =>
        Effect.gen(function* () {
          const result = yield* db
            .select({
              hasForEach: targetStep.hasForEach,
            })
            .from(schema.flow)
            .innerJoin(targetStep, eq(schema.flow.targetStepId, targetStep.id))
            .where(
              and(eq(schema.flow.id, flowId), eq(schema.flow._deleted, false)),
            )
            .limit(1)

          if (!result[0]) {
            return null // Flow not found
          }

          return result[0].hasForEach
        }),

      countActiveTodosForStep: (
        processExecutionId: string,
        targetStepId: string,
      ) =>
        Effect.gen(function* () {
          const result = yield* db
            .select({ count: sql<number>`COUNT(*)`.as("count") })
            .from(schema.toDo)
            .innerJoin(schema.flow, eq(schema.toDo.flowId, schema.flow.id))
            .where(
              and(
                eq(schema.toDo.processExecutionId, processExecutionId),
                eq(schema.flow.targetStepId, targetStepId),
                eq(schema.toDo._deleted, false),
              ),
            )
          return Number(result[0]?.count ?? 0)
        }),

      getStepRetryLimitByPath: (stepPath: string) =>
        Effect.gen(function* () {
          const result = yield* db
            .select({ retryLimit: schema.step.retryLimit })
            .from(schema.step)
            .where(
              and(
                eq(schema.step.path, stepPath),
                eq(schema.step._deleted, false),
              ),
            )
            .limit(1)

          if (!result[0]) {
            yield* Effect.logWarning(
              "getStepRetryLimitByPath: step not found",
              {
                stepPath,
              },
            )
            return null // Step not found
          }

          return result[0].retryLimit
        }),

      queryNotificationRecipientByProviderUserId: (providerUserId: string) =>
        Effect.gen(function* () {
          const result = yield* db
            .select({
              providerUserId: schema.providerUser.id,
              userId: schema.providerUser.userId,
              email: schema.providerUser.email,
              name: schema.providerUser.name,
              firstName: schema.providerUser.firstName,
              lastName: schema.providerUser.lastName,
              notificationPreference:
                schema.userSettings.notificationPreference,
            })
            .from(schema.providerUser)
            .leftJoin(
              schema.userSettings,
              and(
                eq(schema.userSettings.userId, schema.providerUser.userId),
                eq(schema.userSettings._deleted, false),
              ),
            )
            .where(
              and(
                eq(schema.providerUser.id, providerUserId),
                eq(schema.providerUser._deleted, false),
              ),
            )
            .limit(1)

          const row = result[0]
          return row ? mapNotificationRecipientRow(row) : null
        }),

      queryNotificationRecipientsByRoleId: (roleId: string) =>
        Effect.gen(function* () {
          const result = yield* db
            .select({
              providerUserId: schema.providerUser.id,
              userId: schema.providerUser.userId,
              email: schema.providerUser.email,
              name: schema.providerUser.name,
              firstName: schema.providerUser.firstName,
              lastName: schema.providerUser.lastName,
              notificationPreference:
                schema.userSettings.notificationPreference,
            })
            .from(schema.providerUserRole)
            .innerJoin(
              schema.providerUser,
              eq(
                schema.providerUserRole.providerUserId,
                schema.providerUser.id,
              ),
            )
            .leftJoin(
              schema.userSettings,
              and(
                eq(schema.userSettings.userId, schema.providerUser.userId),
                eq(schema.userSettings._deleted, false),
              ),
            )
            .where(
              and(
                eq(schema.providerUserRole.roleId, roleId),
                eq(schema.providerUserRole._deleted, false),
                eq(schema.providerUser._deleted, false),
              ),
            )

          return result.map(mapNotificationRecipientRow)
        }),

      queryNotificationRecipientsByRolePath: (rolePath: string) =>
        Effect.gen(function* () {
          const result = yield* db
            .select({
              providerUserId: schema.providerUser.id,
              userId: schema.providerUser.userId,
              email: schema.providerUser.email,
              name: schema.providerUser.name,
              firstName: schema.providerUser.firstName,
              lastName: schema.providerUser.lastName,
              notificationPreference:
                schema.userSettings.notificationPreference,
            })
            .from(schema.providerUserRole)
            .innerJoin(
              schema.providerUser,
              eq(
                schema.providerUserRole.providerUserId,
                schema.providerUser.id,
              ),
            )
            .innerJoin(
              schema.role,
              eq(schema.providerUserRole.roleId, schema.role.id),
            )
            .leftJoin(
              schema.userSettings,
              and(
                eq(schema.userSettings.userId, schema.providerUser.userId),
                eq(schema.userSettings._deleted, false),
              ),
            )
            .where(
              and(
                eq(schema.role.path, rolePath),
                eq(schema.providerUserRole._deleted, false),
                eq(schema.providerUser._deleted, false),
                eq(schema.role._deleted, false),
              ),
            )

          return result.map(mapNotificationRecipientRow)
        }),
    }
  }),
)
