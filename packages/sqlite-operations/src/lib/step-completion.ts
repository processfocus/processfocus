import { strict as assert } from "node:assert"
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema } from "effect"
import * as schema from "@pf/drizzle-sqlite"
import {
  type CompletedStepData,
  InvalidProcessStateError,
  StepCompletionOperations,
  type TodoCompletionInput,
  type TodoRow,
  type TodoWithProcessState,
  calculateFormComplexity,
  getUserDetails,
  returnedRow,
} from "@pf/graphql-db-operations"
import { getRequestTime } from "@pf/request-time"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"

/**
 * Live implementation of StepCompletionOperations service for SQLite.
 *
 * Contains only database operations without business logic.
 */
export const SqliteStepCompletionOperationsLive = Layer.effect(
  StepCompletionOperations,
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle

    const queryTodo = (todoId: string, includeCompleted: boolean) =>
      Effect.gen(function* () {
        const result = yield* db
          .select({
            id: schema.toDo.id,
            createdBy: schema.toDo.createdBy,
            processExecutionId: schema.toDo.processExecutionId,
            processStateId: schema.processExecution.processStateId,
            startedByUserId: schema.processState.startedByUserId,
            targetStepId: schema.step.id,
            targetStepPath: schema.step.path,
            processPath: schema.process.path,
            orgUnitPath: schema.orgUnit.path,
            assignedToProviderUserId: schema.toDo.assignedToProviderUserId,
            assignedToProviderUserEmail: schema.providerUser.email,
            correctionRequiredAt: schema.toDo.correctionRequiredAt,
            createdAtMs:
              sql<number>`(${schema.toDo.createdAt} - 2440587.5) * 86400000`.as(
                "created_at_ms",
              ),
            orgUnitId: schema.process.orgUnitId,
            itemData: schema.toDo.itemData,
            hasForEach: schema.step.hasForEach,
            barrierScheduledFlowId: schema.toDo.barrierScheduledFlowId,
            completed: schema.toDo._deleted,
          })
          .from(schema.toDo)
          .innerJoin(
            schema.processExecution,
            eq(schema.toDo.processExecutionId, schema.processExecution.id),
          )
          .innerJoin(
            schema.processState,
            eq(schema.processExecution.processStateId, schema.processState.id),
          )
          .innerJoin(
            schema.process,
            eq(schema.processState.processId, schema.process.id),
          )
          .innerJoin(
            schema.orgUnit,
            eq(schema.process.orgUnitId, schema.orgUnit.id),
          )
          .innerJoin(schema.flow, eq(schema.toDo.flowId, schema.flow.id))
          .innerJoin(schema.step, eq(schema.flow.targetStepId, schema.step.id))
          .leftJoin(
            schema.providerUser,
            eq(schema.toDo.assignedToProviderUserId, schema.providerUser.id),
          )
          .where(
            includeCompleted
              ? eq(schema.toDo.id, todoId)
              : and(
                  eq(schema.toDo.id, todoId),
                  eq(schema.toDo._deleted, false),
                ),
          )
          .limit(1)

        return result[0] ?? null
      })

    return {
      queryTodoById: (todoId: string) => queryTodo(todoId, false),
      queryTodoForCompletionById: (todoId: string) => queryTodo(todoId, true),

      queryPublicTodoInfo: (todoId: string) =>
        Effect.gen(function* () {
          const result = yield* db
            .select({
              todoId: schema.toDo.id,
              deleted: schema.toDo._deleted,
              failureReason: schema.toDo.failureReason,
              correctionRequiredAt: schema.toDo.correctionRequiredAt,
              abandonedAt: schema.processExecution.abandonedAt,
              stepPath: schema.step.path,
              itemData: schema.toDo.itemData,
            })
            .from(schema.toDo)
            .innerJoin(
              schema.processExecution,
              eq(schema.toDo.processExecutionId, schema.processExecution.id),
            )
            .innerJoin(schema.flow, eq(schema.toDo.flowId, schema.flow.id))
            .innerJoin(
              schema.step,
              eq(schema.flow.targetStepId, schema.step.id),
            )
            .where(eq(schema.toDo.id, todoId))
            .limit(1)

          const row = result[0]
          if (!row) {
            return {
              todoId,
              status: "unavailable",
              stepPath: null,
              latestPublicCompletionInvitationRecipientEmail: null,
              itemData: null,
            } as const
          }

          const status =
            row.failureReason != null || row.correctionRequiredAt != null
              ? "unavailable"
              : row.deleted
                ? row.abandonedAt
                  ? "unavailable"
                  : "completed"
                : "active"

          const latestInvitation =
            status !== "unavailable"
              ? yield* db
                  .select({
                    email: schema.publicCompletionInvitationAttempt.email,
                  })
                  .from(schema.publicCompletionInvitationAttempt)
                  .where(
                    and(
                      eq(
                        schema.publicCompletionInvitationAttempt.toDoId,
                        todoId,
                      ),
                      eq(
                        schema.publicCompletionInvitationAttempt._deleted,
                        false,
                      ),
                    ),
                  )
                  .orderBy(
                    desc(schema.publicCompletionInvitationAttempt.createdAt),
                    desc(schema.publicCompletionInvitationAttempt.id),
                  )
                  .limit(1)
              : []

          return {
            todoId: row.todoId,
            // Correction-required Todos are still active internally, but public
            // links cannot update recipient state; providers handle correction.
            status,
            stepPath: row.stepPath,
            latestPublicCompletionInvitationRecipientEmail:
              latestInvitation[0]?.email ?? null,
            itemData: row.itemData,
          } as const
        }),

      queryLatestPublicCompletionInvitationAttempt: (todoId) =>
        Effect.gen(function* () {
          const rows = yield* db
            .select({
              id: schema.publicCompletionInvitationAttempt.id,
              email: schema.publicCompletionInvitationAttempt.email,
            })
            .from(schema.publicCompletionInvitationAttempt)
            .where(
              and(
                eq(schema.publicCompletionInvitationAttempt.toDoId, todoId),
                eq(schema.publicCompletionInvitationAttempt._deleted, false),
              ),
            )
            .orderBy(
              desc(schema.publicCompletionInvitationAttempt.createdAt),
              desc(schema.publicCompletionInvitationAttempt.id),
            )
            .limit(1)

          return rows[0] ?? null
        }),

      createPublicCompletionInvitationAttempt: ({ todoId, recipientEmail }) =>
        Effect.gen(function* () {
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()

          const rows = yield* db
            .insert(schema.publicCompletionInvitationAttempt)
            .values({
              toDoId: todoId,
              email: recipientEmail,
              createdAt: requestTime,
              updatedAt: requestTime,
              createdBy: userDetails.by,
              updatedBy: userDetails.by,
            })
            .returning({ id: schema.publicCompletionInvitationAttempt.id })

          return (yield* returnedRow(rows)).id
        }),

      recordPublicCompletionInvitationAttemptReceipt: (attemptId, receipt) =>
        Effect.gen(function* () {
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()

          const rows = yield* db
            .update(schema.publicCompletionInvitationAttempt)
            .set({
              providerMessageId: receipt.providerMessageId,
              providerSentTo: receipt.providerSentTo,
              updatedAt: requestTime,
              updatedBy: userDetails.by,
            })
            .where(
              and(
                eq(schema.publicCompletionInvitationAttempt.id, attemptId),
                eq(schema.publicCompletionInvitationAttempt._deleted, false),
              ),
            )
            .returning({ id: schema.publicCompletionInvitationAttempt.id })

          return rows.length > 0
        }),

      queryPublicCompletionInvitationAttemptCallbackTarget: (
        todoId,
        attemptId,
      ) =>
        Effect.gen(function* () {
          const latest = yield* db
            .select({ id: schema.publicCompletionInvitationAttempt.id })
            .from(schema.publicCompletionInvitationAttempt)
            .where(
              and(
                eq(schema.publicCompletionInvitationAttempt.toDoId, todoId),
                eq(schema.publicCompletionInvitationAttempt._deleted, false),
              ),
            )
            .orderBy(
              desc(schema.publicCompletionInvitationAttempt.createdAt),
              desc(schema.publicCompletionInvitationAttempt.id),
            )
            .limit(1)

          if (latest[0]?.id !== attemptId) {
            return null
          }

          const rows = yield* db
            .select({
              attemptId: schema.publicCompletionInvitationAttempt.id,
              todoId: schema.toDo.id,
              providerMessageId:
                schema.publicCompletionInvitationAttempt.providerMessageId,
              providerSentTo:
                schema.publicCompletionInvitationAttempt.providerSentTo,
              processExecutionId: schema.toDo.processExecutionId,
              assignedToProviderUserId: schema.toDo.assignedToProviderUserId,
              roleId: schema.step.roleId,
              stepPath: schema.step.path,
              stepName: schema.step.name,
              processName: schema.process.name,
            })
            .from(schema.publicCompletionInvitationAttempt)
            .innerJoin(
              schema.toDo,
              eq(
                schema.publicCompletionInvitationAttempt.toDoId,
                schema.toDo.id,
              ),
            )
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
                eq(schema.publicCompletionInvitationAttempt.id, attemptId),
                eq(schema.publicCompletionInvitationAttempt.toDoId, todoId),
                eq(schema.publicCompletionInvitationAttempt._deleted, false),
                eq(schema.toDo._deleted, false),
                isNull(schema.toDo.completedByUserId),
                isNull(schema.toDo.completedByExternalParticipantId),
                isNull(schema.toDo.completedByRoleId),
                isNull(schema.toDo.failureReason),
                isNull(schema.toDo.correctionRequiredAt),
                eq(schema.flow._deleted, false),
                eq(schema.step._deleted, false),
                eq(schema.process._deleted, false),
              ),
            )
            .limit(1)

          return rows[0] ?? null
        }),

      recordPublicCompletionInvitationAttemptDeliveryEvent: (
        attemptId,
        event,
      ) =>
        Effect.gen(function* () {
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()

          const rows = yield* db
            .update(schema.publicCompletionInvitationAttempt)
            .set({
              deliveryStatus: event.deliveryStatus,
              deliveryEventId: event.deliveryEventId,
              deliveryFailureKind:
                event.deliveryStatus === "failed"
                  ? (event.deliveryFailureKind ?? null)
                  : null,
              deliveryFailureReason:
                event.deliveryStatus === "failed"
                  ? (event.deliveryFailureReason ?? null)
                  : null,
              ...(event.providerMessageId !== undefined && {
                providerMessageId: event.providerMessageId,
              }),
              updatedAt: requestTime,
              updatedBy: userDetails.by,
            })
            .where(
              and(
                eq(schema.publicCompletionInvitationAttempt.id, attemptId),
                eq(schema.publicCompletionInvitationAttempt._deleted, false),
              ),
            )
            .returning({ id: schema.publicCompletionInvitationAttempt.id })

          return rows.length > 0
        }),

      enterPublicCompletionCorrectionRequired: (input) =>
        Effect.gen(function* () {
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()

          const rows = yield* db
            .update(schema.toDo)
            .set({
              // Correction fields are one state bundle: entered time, failure
              // details, and the invitation attempt that needs correction.
              correctionRequiredAt: requestTime,
              correctionFailureReason: input.failureReason,
              correctionInvitationAttemptId: input.invitationAttemptId,
              updatedAt: requestTime,
              updatedBy: userDetails.by,
            })
            .where(
              and(
                eq(schema.toDo.id, input.todoId),
                eq(schema.toDo._deleted, false),
                isNull(schema.toDo.completedByUserId),
                isNull(schema.toDo.completedByExternalParticipantId),
                isNull(schema.toDo.completedByRoleId),
                isNull(schema.toDo.failureReason),
                isNull(schema.toDo.correctionRequiredAt),
              ),
            )
            .returning({
              id: schema.toDo.id,
              processExecutionId: schema.toDo.processExecutionId,
            })

          const row = rows[0]
          if (!row) return false

          yield* db
            .update(schema.processExecution)
            .set({
              updatedAt: requestTime,
              updatedBy: userDetails.by,
            })
            .where(eq(schema.processExecution.id, row.processExecutionId))

          return true
        }),

      queryPublicCompletionCorrectionRecipient: (todoId) =>
        Effect.gen(function* () {
          const rows = yield* db
            .select({
              recipientEmail: schema.publicCompletionInvitationAttempt.email,
              failureReason: schema.toDo.correctionFailureReason,
            })
            .from(schema.toDo)
            .innerJoin(
              schema.publicCompletionInvitationAttempt,
              eq(
                schema.toDo.correctionInvitationAttemptId,
                schema.publicCompletionInvitationAttempt.id,
              ),
            )
            .where(
              and(
                eq(schema.toDo.id, todoId),
                eq(schema.toDo._deleted, false),
                isNull(schema.toDo.completedByUserId),
                isNull(schema.toDo.completedByExternalParticipantId),
                isNull(schema.toDo.completedByRoleId),
                isNull(schema.toDo.failureReason),
                isNotNull(schema.toDo.correctionRequiredAt),
                eq(schema.publicCompletionInvitationAttempt._deleted, false),
              ),
            )
            .limit(1)

          return rows[0] ?? null
        }),

      clearPublicCompletionCorrectionRequired: (todoId) =>
        Effect.gen(function* () {
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()

          const rows = yield* db
            .update(schema.toDo)
            .set({
              correctionRequiredAt: null,
              correctionFailureReason: null,
              correctionInvitationAttemptId: null,
              updatedAt: requestTime,
              updatedBy: userDetails.by,
            })
            .where(
              and(
                eq(schema.toDo.id, todoId),
                eq(schema.toDo._deleted, false),
                isNull(schema.toDo.completedByUserId),
                isNull(schema.toDo.completedByExternalParticipantId),
                isNull(schema.toDo.completedByRoleId),
                isNull(schema.toDo.failureReason),
                isNotNull(schema.toDo.correctionRequiredAt),
              ),
            )
            .returning({
              id: schema.toDo.id,
              processExecutionId: schema.toDo.processExecutionId,
            })

          const row = rows[0]
          if (!row) return false

          yield* db
            .update(schema.processExecution)
            .set({
              updatedAt: requestTime,
              updatedBy: userDetails.by,
            })
            .where(eq(schema.processExecution.id, row.processExecutionId))

          return true
        }),

      updateProcessState: (
        processStateId: string,
        data: Record<string, unknown>,
      ) =>
        Effect.gen(function* () {
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()

          // SQLite: Use json_patch for deep merge
          // json_patch(state, ?) recursively merges the new data into existing state
          // globalThis.JSON.stringify for SQL parameter binding
          yield* db
            .update(schema.processState)
            .set({
              state: sql`json_patch(${schema.processState.state}, ${globalThis.JSON.stringify(data)})`,
              updatedAt: requestTime,
              updatedBy: userDetails.by,
            })
            .where(eq(schema.processState.id, processStateId))
        }),

      updateProcessStateIfUnchanged: (
        processStateId: string,
        expectedUpdatedAt: DateTime.Utc,
        data: Record<string, unknown>,
      ) =>
        Effect.gen(function* () {
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()
          const updatedAt =
            DateTime.toEpochMillis(requestTime) >
            DateTime.toEpochMillis(expectedUpdatedAt)
              ? requestTime
              : DateTime.add(expectedUpdatedAt, { millis: 1 })
          const rows = yield* db
            .update(schema.processState)
            .set({
              state: sql`json_patch(${schema.processState.state}, ${globalThis.JSON.stringify(data)})`,
              updatedAt,
              updatedBy: userDetails.by,
            })
            .where(
              and(
                eq(schema.processState.id, processStateId),
                sql`ROUND((${schema.processState.updatedAt} - 2440587.5) * 86400000) = ${Math.round(DateTime.toEpochMillis(expectedUpdatedAt))}`,
              ),
            )
            .returning({
              updatedAtMs: sql<number>`ROUND((${schema.processState.updatedAt} - 2440587.5) * 86400000)`,
            })

          const row = rows[0]
          return row
            ? {
                kind: "updated" as const,
                updatedAt: DateTime.unsafeMake(row.updatedAtMs),
              }
            : { kind: "conflict" as const }
        }),

      appendProcessStateArrayItem: (
        processStateId: string,
        stateKey: string,
        item: unknown,
      ) =>
        Effect.gen(function* () {
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()
          const path = `$.${stateKey}`
          const itemJson = globalThis.JSON.stringify(item)

          yield* db
            .update(schema.processState)
            .set({
              state: sql`json_set(COALESCE(${schema.processState.state}, json('{}')), ${path}, json_insert(COALESCE(json_extract(${schema.processState.state}, ${path}), json('[]')), '$[#]', json(${itemJson})))`,
              updatedAt: requestTime,
              updatedBy: userDetails.by,
            })
            .where(eq(schema.processState.id, processStateId))
        }),

      appendProcessStateArrayItemIfUnchanged: (
        processStateId: string,
        expectedUpdatedAt: DateTime.Utc,
        stateKey: string,
        item: unknown,
      ) =>
        Effect.gen(function* () {
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()
          const updatedAt =
            DateTime.toEpochMillis(requestTime) >
            DateTime.toEpochMillis(expectedUpdatedAt)
              ? requestTime
              : DateTime.add(expectedUpdatedAt, { millis: 1 })
          const path = `$.${stateKey}`
          const itemJson = globalThis.JSON.stringify(item)
          const rows = yield* db
            .update(schema.processState)
            .set({
              state: sql`json_set(COALESCE(${schema.processState.state}, json('{}')), ${path}, json_insert(COALESCE(json_extract(${schema.processState.state}, ${path}), json('[]')), '$[#]', json(${itemJson})))`,
              updatedAt,
              updatedBy: userDetails.by,
            })
            .where(
              and(
                eq(schema.processState.id, processStateId),
                sql`ROUND((${schema.processState.updatedAt} - 2440587.5) * 86400000) = ${Math.round(DateTime.toEpochMillis(expectedUpdatedAt))}`,
              ),
            )
            .returning({
              updatedAtMs: sql<number>`ROUND((${schema.processState.updatedAt} - 2440587.5) * 86400000)`,
            })
          const row = rows[0]
          return row
            ? {
                kind: "updated" as const,
                updatedAt: DateTime.unsafeMake(row.updatedAtMs),
              }
            : { kind: "conflict" as const }
        }),

      completeToDo: (
        todoId: string,
        userId: string | null,
        businessDurationMs: number | null,
        externalParticipantId?: string,
        completedByRoleId?: string,
      ) =>
        Effect.gen(function* () {
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()

          // Complete the todo: set completedByUserId, businessDuration, and soft-delete
          yield* db
            .update(schema.toDo)
            .set({
              completedByUserId: userId,
              ...(externalParticipantId !== undefined
                ? { completedByExternalParticipantId: externalParticipantId }
                : {}),
              ...(completedByRoleId !== undefined ? { completedByRoleId } : {}),
              businessDuration: businessDurationMs,
              failureReason: null,
              notStartedReason: null,
              // Clear the correction state bundle together on completion.
              correctionRequiredAt: null,
              correctionFailureReason: null,
              correctionInvitationAttemptId: null,
              _deleted: true,
              updatedAt: requestTime,
              updatedBy: userDetails.by,
            })
            .where(eq(schema.toDo.id, todoId))

          // Fetch the complete todo with joins (same pattern as flow-execution.ts:61-105)
          const rows = yield* db
            .select({
              id: schema.toDo.id,
              processExecutionId: schema.toDo.processExecutionId,
              flowId: schema.toDo.flowId,
              processName: schema.process.name,
              processPath: schema.process.path,
              processOrgUnitPath: schema.orgUnit.path,
              stepName: schema.step.name,
              stepPath: schema.step.path,
              rolePath: schema.role.path,
              assignedToProviderUserId: schema.toDo.assignedToProviderUserId,
              assignedToProviderUserEmail: schema.providerUser.email,
              role: schema.role.name,
              description: schema.step.purpose,
              formFields: schema.step.formFields,
              updatedAt:
                sql<number>`(${schema.toDo.updatedAt} - 2440587.5) * 86400000`.as(
                  "updated_at_millis",
                ),
              createdAt:
                sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', (${schema.toDo.createdAt} - 2440587.5) * 86400, 'unixepoch')`.as(
                  "created_at_iso",
                ),
              // Pre-calculated SLA target and warning times (stored as Julian Day in SQLite)
              slaTargetAt: sql<
                string | null
              >`CASE WHEN ${schema.toDo.slaTargetAt} IS NOT NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ', (${schema.toDo.slaTargetAt} - 2440587.5) * 86400, 'unixepoch') ELSE NULL END`.as(
                "sla_target_at_iso",
              ),
              slaWarningAt: sql<
                string | null
              >`CASE WHEN ${schema.toDo.slaWarningAt} IS NOT NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ', (${schema.toDo.slaWarningAt} - 2440587.5) * 86400, 'unixepoch') ELSE NULL END`.as(
                "sla_warning_at_iso",
              ),
              deleted: schema.toDo._deleted,
            })
            .from(schema.toDo)
            .innerJoin(
              schema.processExecution,
              eq(schema.toDo.processExecutionId, schema.processExecution.id),
            )
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
            .innerJoin(
              schema.orgUnit,
              eq(schema.process.orgUnitId, schema.orgUnit.id),
            )
            .innerJoin(schema.flow, eq(schema.toDo.flowId, schema.flow.id))
            .innerJoin(
              schema.step,
              eq(schema.flow.targetStepId, schema.step.id),
            )
            .leftJoin(schema.role, eq(schema.step.roleId, schema.role.id))
            .leftJoin(
              schema.providerUser,
              eq(schema.toDo.assignedToProviderUserId, schema.providerUser.id),
            )
            .where(eq(schema.toDo.id, todoId))
            .limit(1)

          assert(rows[0]) // silence type checker

          // Map to TodoRow shape
          const row = rows[0]
          return {
            id: row.id,
            processExecutionId: row.processExecutionId,
            flowId: row.flowId,
            processName: row.processName,
            processPath: row.processPath,
            processOrgUnitPath: row.processOrgUnitPath,
            stepName: row.stepName,
            stepPath: row.stepPath,
            rolePath: row.rolePath,
            assignedToProviderUserId: row.assignedToProviderUserId,
            assignedToProviderUserEmail: row.assignedToProviderUserEmail,
            role: row.role,
            description: row.description,
            status: "Active", // Phase 1: default value
            priority: "Medium", // Phase 1: default value
            assignedAt: row.createdAt, // Now ISO string
            dueAt: row.slaTargetAt, // Pre-calculated from SLA at todo creation
            dueWarningAt: row.slaWarningAt, // Pre-calculated from SLA at todo creation
            formComplexity: calculateFormComplexity(row.formFields),
            updatedAt: row.updatedAt,
            deleted: row.deleted,
            summary: [], // Not computed for completed todos
          } satisfies TodoRow
        }),

      completeToDoIfOpen: (input: TodoCompletionInput) =>
        Effect.gen(function* () {
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()
          const rows = yield* db
            .update(schema.toDo)
            .set({
              completedByUserId: input.userId,
              completedByExternalParticipantId: input.externalParticipantId,
              completedByRoleId: input.completedByRoleId,
              businessDuration: input.businessDurationMs,
              failureReason: null,
              notStartedReason: null,
              correctionRequiredAt: null,
              correctionFailureReason: null,
              correctionInvitationAttemptId: null,
              _deleted: true,
              updatedAt: requestTime,
              updatedBy: userDetails.by,
            })
            .where(
              and(
                eq(schema.toDo.id, input.todoId),
                eq(schema.toDo._deleted, false),
              ),
            )
            .returning({ id: schema.toDo.id })

          if (rows[0]) return { kind: "completed" as const }

          const existing = yield* db
            .select({
              deleted: schema.toDo._deleted,
              completedByUserId: schema.toDo.completedByUserId,
              completedByExternalParticipantId:
                schema.toDo.completedByExternalParticipantId,
              completedByRoleId: schema.toDo.completedByRoleId,
              businessDuration: schema.toDo.businessDuration,
            })
            .from(schema.toDo)
            .where(eq(schema.toDo.id, input.todoId))
            .limit(1)

          const row = existing[0]
          if (!row) return { kind: "not-found" as const }
          if (
            row.deleted &&
            row.completedByUserId === input.userId &&
            row.completedByExternalParticipantId ===
              input.externalParticipantId &&
            row.completedByRoleId === input.completedByRoleId
          ) {
            return { kind: "already-completed" as const }
          }
          return { kind: "conflict" as const }
        }),

      completeAsyncToDo: (
        todoId: string,
        userId: string | null,
        businessDurationMs: number | null,
        completedByRoleId?: string,
      ) =>
        Effect.gen(function* () {
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()

          // Clear any recorded failure so a later success callback can recover
          // the deferred todo and mark it completed.
          const result = yield* db
            .update(schema.toDo)
            .set({
              completedByUserId: userId,
              businessDuration: businessDurationMs,
              failureReason: null,
              notStartedReason: null,
              // Clear the correction state bundle together on completion.
              correctionRequiredAt: null,
              correctionFailureReason: null,
              correctionInvitationAttemptId: null,
              _deleted: true,
              ...(completedByRoleId !== undefined ? { completedByRoleId } : {}),
              updatedAt: requestTime,
              updatedBy: userDetails.by,
            })
            .where(
              and(eq(schema.toDo.id, todoId), eq(schema.toDo._deleted, false)),
            )
            .returning({ id: schema.toDo.id })

          return result.length > 0
        }),

      failToDo: (todoId: string, failureReason: string) =>
        Effect.gen(function* () {
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()

          yield* db
            .update(schema.toDo)
            .set({
              failureReason,
              notStartedReason: null,
              // Clear stale correction state when this Todo becomes failed.
              correctionRequiredAt: null,
              correctionFailureReason: null,
              correctionInvitationAttemptId: null,
              completedByUserId: null,
              _deleted: false,
              updatedAt: requestTime,
              updatedBy: userDetails.by,
            })
            .where(
              and(eq(schema.toDo.id, todoId), eq(schema.toDo._deleted, false)),
            )
        }),

      failAsyncToDo: (todoId: string, failureReason: string) =>
        Effect.gen(function* () {
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()

          const result = yield* db
            .update(schema.toDo)
            .set({
              failureReason,
              notStartedReason: null,
              updatedAt: requestTime,
              updatedBy: userDetails.by,
            })
            .where(
              and(
                eq(schema.toDo.id, todoId),
                eq(schema.toDo._deleted, false),
                isNull(schema.toDo.failureReason),
                isNull(schema.toDo.correctionRequiredAt),
              ),
            )
            .returning({ id: schema.toDo.id })

          return result.length > 0
        }),

      getProcessStateByTodoId: (todoId: string) =>
        Effect.gen(function* () {
          const result = yield* db
            .select({
              processExecutionId: schema.processExecution.id,
              processStateId: schema.processState.id,
              state: schema.processState.state,
              updatedAtMs: sql<number>`ROUND((${schema.processState.updatedAt} - 2440587.5) * 86400000)`,
              // SQLite: Convert Julian day to JS Date via milliseconds
              processStartedAt:
                sql<number>`(${schema.processExecution.createdAt} - 2440587.5) * 86400000`.as(
                  "process_started_at_millis",
                ),
            })
            .from(schema.toDo)
            .innerJoin(
              schema.processExecution,
              eq(schema.toDo.processExecutionId, schema.processExecution.id),
            )
            .innerJoin(
              schema.processState,
              eq(
                schema.processExecution.processStateId,
                schema.processState.id,
              ),
            )
            .where(
              and(eq(schema.toDo.id, todoId), eq(schema.toDo._deleted, false)),
            )
            .limit(1)

          if (!result[0]) {
            return null
          }

          // Validate state is a Record<string, unknown>
          const StateSchema = Schema.Record({
            key: Schema.String,
            value: Schema.Unknown,
          })
          const parseResult = Schema.decodeUnknownEither(StateSchema)(
            result[0].state ?? {},
          )

          if (parseResult._tag === "Left") {
            return yield* new InvalidProcessStateError({
              processStateId: result[0].processStateId,
              message: `Process state has invalid format in database`,
            })
          }

          return {
            processExecutionId: result[0].processExecutionId,
            processStateId: result[0].processStateId,
            state: parseResult.right,
            updatedAt: DateTime.unsafeMake(result[0].updatedAtMs),
            processStartedAt: DateTime.unsafeFromDate(
              new Date(result[0].processStartedAt),
            ),
          }
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
                sql`json_extract(${schema.jobQueue.jobPayload}, '$.processExecutionId') = ${processExecutionId}`,
              ),
            )
          return Number(result[0]?.count ?? 0)
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

      getProcessStatesByTodoIds: (todoIds: string[]) =>
        Effect.gen(function* () {
          if (todoIds.length === 0) {
            return []
          }

          const results = yield* db
            .select({
              todoId: schema.toDo.id,
              processExecutionId: schema.processExecution.id,
              processStateId: schema.processState.id,
              state: schema.processState.state,
              stepPath: schema.step.path,
              itemData: schema.toDo.itemData,
              // SQLite: Convert Julian day to JS Date via milliseconds
              processStartedAt:
                sql<number>`(${schema.processExecution.createdAt} - 2440587.5) * 86400000`.as(
                  "process_started_at_millis",
                ),
            })
            .from(schema.toDo)
            .innerJoin(
              schema.processExecution,
              eq(schema.toDo.processExecutionId, schema.processExecution.id),
            )
            .innerJoin(
              schema.processState,
              eq(
                schema.processExecution.processStateId,
                schema.processState.id,
              ),
            )
            .innerJoin(schema.flow, eq(schema.toDo.flowId, schema.flow.id))
            .innerJoin(
              schema.step,
              eq(schema.flow.targetStepId, schema.step.id),
            )
            .where(inArray(schema.toDo.id, todoIds))

          // Validate and transform results
          const StateSchema = Schema.Record({
            key: Schema.String,
            value: Schema.Unknown,
          })

          const validated: TodoWithProcessState[] = []
          for (const result of results) {
            const parseResult = Schema.decodeUnknownEither(StateSchema)(
              result.state ?? {},
            )

            if (parseResult._tag === "Left") {
              return yield* new InvalidProcessStateError({
                processStateId: result.processStateId,
                message: `Process state has invalid format in database`,
              })
            }

            validated.push({
              todoId: result.todoId,
              processExecutionId: result.processExecutionId,
              processStateId: result.processStateId,
              state: parseResult.right,
              stepPath: result.stepPath,
              processStartedAt: DateTime.unsafeFromDate(
                new Date(result.processStartedAt),
              ),
              itemData: result.itemData,
            })
          }

          return validated
        }),

      getCompletedStepsForExecution: (processExecutionId: string) =>
        Effect.gen(function* () {
          // First, get the start step info from process_state/process_execution.
          // The start step doesn't have a todo - it's completed directly by the mutation.
          // We synthesize a CompletedStepData from process_state.startedByUserId.
          const startStepResults = yield* db
            .select({
              stepPath: schema.step.path,
              userId: schema.user.id,
              userSub: schema.user.sub,
              providerUserId:
                sql<string>`COALESCE(${schema.providerUser.id}, ${schema.user.id})`.as(
                  "assigned_to_provider_user_id",
                ),
              providerUserName:
                sql<string>`COALESCE(${schema.providerUser.name}, ${schema.user.sub})`.as(
                  "provider_user_name",
                ),
              providerUserFirstName:
                sql<string>`COALESCE(${schema.providerUser.firstName}, ${schema.user.sub})`.as(
                  "provider_user_first_name",
                ),
              providerUserLastName:
                sql<string>`COALESCE(${schema.providerUser.lastName}, '')`.as(
                  "provider_user_last_name",
                ),
              providerUserEmail:
                sql<string>`COALESCE(${schema.providerUser.email}, ${schema.user.sub})`.as(
                  "provider_user_email",
                ),
              providerUserPicture:
                sql<string>`COALESCE(${schema.providerUser.picture}, '')`.as(
                  "provider_user_picture",
                ),
              // Start step completed when process execution was created
              completedAt:
                sql<number>`(${schema.processExecution.createdAt} - 2440587.5) * 86400000`.as(
                  "completed_at_millis",
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
              schema.step,
              eq(schema.processState.startStepId, schema.step.id),
            )
            .innerJoin(
              schema.user,
              eq(schema.processState.startedByUserId, schema.user.id),
            )
            .leftJoin(
              schema.providerUser,
              eq(schema.user.id, schema.providerUser.userId),
            )
            .where(eq(schema.processExecution.id, processExecutionId))

          // Then, query completed todos (soft-deleted with completedByUserId set)
          // joined with user and optionally providerUser to get step completer info.
          // Use COALESCE to provide fallback values from user.sub when providerUser is null
          // (e.g., for M2M/system users that don't have provider user records).
          const todoResults = yield* db
            .select({
              stepPath: schema.step.path,
              userId: schema.user.id,
              userSub: schema.user.sub,
              // COALESCE: use providerUser fields if available, else use user.sub as fallback
              providerUserId:
                sql<string>`COALESCE(${schema.providerUser.id}, ${schema.user.id})`.as(
                  "assigned_to_provider_user_id",
                ),
              providerUserName:
                sql<string>`COALESCE(${schema.providerUser.name}, ${schema.user.sub})`.as(
                  "provider_user_name",
                ),
              providerUserFirstName:
                sql<string>`COALESCE(${schema.providerUser.firstName}, ${schema.user.sub})`.as(
                  "provider_user_first_name",
                ),
              providerUserLastName:
                sql<string>`COALESCE(${schema.providerUser.lastName}, '')`.as(
                  "provider_user_last_name",
                ),
              providerUserEmail:
                sql<string>`COALESCE(${schema.providerUser.email}, ${schema.user.sub})`.as(
                  "provider_user_email",
                ),
              providerUserPicture:
                sql<string>`COALESCE(${schema.providerUser.picture}, '')`.as(
                  "provider_user_picture",
                ),
              // SQLite: Convert Julian day to JS Date via milliseconds
              completedAt:
                sql<number>`(${schema.toDo.updatedAt} - 2440587.5) * 86400000`.as(
                  "completed_at_millis",
                ),
            })
            .from(schema.toDo)
            .innerJoin(schema.flow, eq(schema.toDo.flowId, schema.flow.id))
            .innerJoin(
              schema.step,
              eq(schema.flow.targetStepId, schema.step.id),
            )
            .innerJoin(
              schema.user,
              eq(schema.toDo.completedByUserId, schema.user.id),
            )
            .leftJoin(
              schema.providerUser,
              eq(schema.user.id, schema.providerUser.userId),
            )
            .where(
              and(
                eq(schema.toDo.processExecutionId, processExecutionId),
                eq(schema.toDo._deleted, true),
                isNotNull(schema.toDo.completedByUserId),
              ),
            )

          // Combine start step + completed todos
          const allResults = [...startStepResults, ...todoResults]

          // Map to CompletedStepData
          return allResults.map(
            (row): CompletedStepData => ({
              stepPath: row.stepPath,
              userId: row.userId,
              userSub: row.userSub,
              providerUserId: row.providerUserId,
              providerUserName: row.providerUserName,
              providerUserFirstName: row.providerUserFirstName,
              providerUserLastName: row.providerUserLastName,
              providerUserEmail: row.providerUserEmail,
              providerUserPicture: row.providerUserPicture,
              completedAt: DateTime.unsafeFromDate(new Date(row.completedAt)),
            }),
          )
        }),

      queryFailedTodosForExecution: (executionId: string) =>
        Effect.gen(function* () {
          const results = yield* db
            .select({
              todoId: schema.toDo.id,
              stepPath: schema.step.path,
              isSystemStep:
                sql<boolean>`CASE WHEN ${schema.step.roleId} IS NULL THEN 1 ELSE 0 END`.as(
                  "is_system_step",
                ),
            })
            .from(schema.toDo)
            .innerJoin(schema.flow, eq(schema.toDo.flowId, schema.flow.id))
            .innerJoin(
              schema.step,
              eq(schema.flow.targetStepId, schema.step.id),
            )
            .where(
              and(
                eq(schema.toDo.processExecutionId, executionId),
                eq(schema.toDo._deleted, false),
                isNotNull(schema.toDo.failureReason),
              ),
            )

          return results.map((row) => ({
            todoId: row.todoId,
            stepPath: row.stepPath,
            isSystemStep: row.isSystemStep,
          }))
        }),

      clearTodoFailures: (todoIds: string[]) =>
        Effect.gen(function* () {
          if (todoIds.length === 0) {
            return
          }
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()

          yield* db
            .update(schema.toDo)
            .set({
              failureReason: null,
              notStartedReason: null,
              updatedAt: requestTime,
              updatedBy: userDetails.by,
            })
            .where(inArray(schema.toDo.id, todoIds))
        }),

      clearProcessExecutionFinished: (executionId: string) =>
        Effect.gen(function* () {
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()

          yield* db
            .update(schema.processExecution)
            .set({
              finishedAt: null,
              businessDuration: null,
              // Terminal system-step failures store the reason here with
              // abandonedAt null. Restart must clear it or the execution stays
              // Failed after the Todo is reopened.
              abandonedReason: null,
              updatedAt: requestTime,
              updatedBy: userDetails.by,
            })
            .where(eq(schema.processExecution.id, executionId))
        }),

      reopenFailedSystemStartExecution: (executionId: string) =>
        Effect.gen(function* () {
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()

          const rows = yield* db
            .update(schema.processExecution)
            .set({
              finishedAt: null,
              businessDuration: null,
              // System-start failures store the failure text in abandonedReason
              // with abandonedAt null. Clear only that failure representation.
              abandonedReason: null,
              updatedAt: requestTime,
              updatedBy: userDetails.by,
            })
            .where(
              and(
                eq(schema.processExecution.id, executionId),
                isNotNull(schema.processExecution.finishedAt),
                isNull(schema.processExecution.abandonedAt),
                isNotNull(schema.processExecution.abandonedReason),
              ),
            )
            .returning({ id: schema.processExecution.id })

          return rows.length > 0
        }),

      queryActiveTodoStepPaths: (executionId: string) =>
        Effect.gen(function* () {
          const results = yield* db
            .selectDistinct({
              stepPath: schema.step.path,
            })
            .from(schema.toDo)
            .innerJoin(schema.flow, eq(schema.toDo.flowId, schema.flow.id))
            .innerJoin(
              schema.step,
              eq(schema.flow.targetStepId, schema.step.id),
            )
            .where(
              and(
                eq(schema.toDo.processExecutionId, executionId),
                eq(schema.toDo._deleted, false),
                isNull(schema.toDo.failureReason),
              ),
            )

          return results.map((r) => r.stepPath)
        }),

      setProcessExecutionAbandoned: (executionId: string, reason?: string) =>
        Effect.gen(function* () {
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()

          yield* db
            .update(schema.processExecution)
            .set({
              finishedAt: requestTime,
              abandonedAt: requestTime,
              updatedAt: requestTime,
              updatedBy: userDetails.by,
              ...(reason === undefined ? {} : { abandonedReason: reason }),
            })
            .where(eq(schema.processExecution.id, executionId))
        }),

      softDeleteActiveTodosForExecution: (executionId: string) =>
        Effect.gen(function* () {
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()

          const result = yield* db
            .update(schema.toDo)
            .set({
              _deleted: true,
              failureReason: "Execution abandoned",
              updatedAt: requestTime,
              updatedBy: userDetails.by,
            })
            .where(
              and(
                eq(schema.toDo.processExecutionId, executionId),
                eq(schema.toDo._deleted, false),
              ),
            )
            .returning({ id: schema.toDo.id })

          return result.map((r) => r.id)
        }),
    }
  }),
)
