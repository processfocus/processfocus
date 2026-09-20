import { and, eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import * as schema from "@pf/drizzle-sqlite"
import {
  ProcessExecutionOperations,
  StepNotFoundError,
  getUserDetails,
  returnedRow,
} from "@pf/graphql-db-operations"
import { getRequestTime } from "@pf/request-time"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"

/**
 * Live implementation of ProcessExecutionOperations service for SQLite.
 */
export const SqliteProcessExecutionOperationsLive = Layer.effect(
  ProcessExecutionOperations,
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle

    return {
      insertProcessState: (
        processId: string,
        startStepPath: string,
        state: Record<string, unknown>,
        startedByExternalParticipantId?: string,
        startedByRoleId?: string,
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

          const result = yield* db
            .insert(schema.processState)
            .values({
              processId,
              startStepId: stepRow.id,
              state: state,
              startedByUserId:
                startedByExternalParticipantId === undefined
                  ? userDetails.id
                  : null,
              ...(startedByExternalParticipantId !== undefined
                ? { startedByExternalParticipantId }
                : {}),
              ...(startedByRoleId !== undefined ? { startedByRoleId } : {}),
              createdAt: requestTime,
              updatedAt: requestTime,
              createdBy: userDetails.by,
              updatedBy: userDetails.by,
            })
            .returning({ id: schema.processState.id })

          const row = yield* returnedRow(result)
          return { processStateId: row.id, stepId: stepRow.id }
        }),

      insertProcessExecution: (
        processStateId: string,
        executionId?: string,
        withoutWaiting = false,
      ) =>
        Effect.gen(function* () {
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()

          const result = yield* db
            .insert(schema.processExecution)
            .values({
              ...(executionId !== undefined ? { id: executionId } : {}),
              processStateId,
              withoutWaiting,
              createdAt: requestTime,
              updatedAt: requestTime,
              createdBy: userDetails.by,
              updatedBy: userDetails.by,
            })
            .returning({ id: schema.processExecution.id })

          return (yield* returnedRow(result)).id
        }),

      getProcessExecutionStartInfo: (executionId: string) =>
        Effect.gen(function* () {
          const result = yield* db
            .select({
              executionId: schema.processExecution.id,
              withoutWaiting: schema.processExecution.withoutWaiting,
              processId: schema.processState.processId,
              stepId: schema.step.id,
              startStepPath: schema.step.path,
              state: schema.processState.state,
            })
            .from(schema.processExecution)
            .innerJoin(
              schema.processState,
              and(
                eq(
                  schema.processExecution.processStateId,
                  schema.processState.id,
                ),
                eq(schema.processState._deleted, false),
              ),
            )
            .innerJoin(
              schema.step,
              and(
                eq(schema.processState.startStepId, schema.step.id),
                eq(schema.step._deleted, false),
              ),
            )
            .where(
              and(
                eq(schema.processExecution.id, executionId),
                eq(schema.processExecution._deleted, false),
              ),
            )
            .limit(1)

          const row = result[0]
          if (!row) {
            return null
          }

          return {
            executionId: row.executionId,
            withoutWaiting: row.withoutWaiting,
            processId: row.processId,
            stepId: row.stepId,
            startStepPath: row.startStepPath,
            state: row.state as Record<string, unknown>,
          }
        }),
    }
  }),
)
