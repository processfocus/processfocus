import type { SqlClient } from "@effect/sql"
import type { QueueService as QueueServiceType } from "@processfocus/runtime"
import { DateTime, Duration, Effect } from "effect"
import {
  calculateBusinessDuration,
  makeBusinessCalendarService,
} from "@pf/business-calendar"
import { recordSuccessfulStepCompletion } from "@pf/business-metrics"
import { withReadSnapshot } from "@pf/db-info"
import type {
  BusinessCalendarQueries,
  CompletedJobOperations,
  FlowExecutionOperations,
  ScheduledFlowOperations,
  StepCompletionOperations,
} from "@pf/graphql-db-operations"
import {
  EXECUTION_EVENT_QUEUE,
  FLOW_EXECUTION_QUEUE,
  PROCESS_EVENT_QUEUE,
  SYSTEM_STEP_EXECUTION_QUEUE,
  TODO_EVENT_QUEUE,
  buildCalendarConfig,
  hasCalendarConfigured,
} from "@pf/graphql-db-operations"
import { getStepIdFromPath, toCamelCase } from "@pf/process"
import { getRequestTime } from "@pf/request-time"
import { hasMatchingOnErrorFlow } from "./on-error-routing"
import {
  drainSystemStepFlowDispatch,
  persistSystemStepFlowDispatch,
  systemStepTodoDispatchId,
} from "./system-step-flow-dispatch"

/**
 * Calculate business duration for a step.
 * Returns the duration in milliseconds.
 * If no calendar is configured, falls back to wallclock time.
 */
const calculateStepBusinessDuration = (
  sqlClient: SqlClient.SqlClient,
  calendarQueries: BusinessCalendarQueries["Type"],
  createdAtMs: number,
  completedAtMs: number,
  orgUnitId: string,
) =>
  Effect.gen(function* () {
    // Load calendar data for the org unit
    const calendarDataMap = yield* withReadSnapshot(
      sqlClient,
      calendarQueries.getCalendarData([orgUnitId]),
    )
    const calendarData = calendarDataMap.get(orgUnitId)

    if (calendarData && hasCalendarConfigured(calendarData)) {
      // Use business hours calculation
      const config = yield* buildCalendarConfig(calendarData)
      const calendarService = yield* makeBusinessCalendarService(config)

      const duration = yield* calculateBusinessDuration(
        calendarService,
        createdAtMs,
        completedAtMs,
      )

      return Duration.toMillis(duration)
    }

    // Fallback: use wallclock time
    return completedAtMs - createdAtMs
  })

const getForEachStepKey = (stepPath: string) =>
  toCamelCase(getStepIdFromPath(stepPath))

const enqueueTodoProcessExecutionEvents = (params: {
  todoId: string
  processExecutionId: string
  queueService: QueueServiceType["Type"]
  flowExecutionOps: FlowExecutionOperations["Type"]
}) =>
  Effect.gen(function* () {
    const { todoId, processExecutionId, queueService, flowExecutionOps } =
      params

    yield* queueService.enqueue(TODO_EVENT_QUEUE, {
      todoIds: [todoId],
    })

    const processId =
      yield* flowExecutionOps.getProcessIdForExecution(processExecutionId)
    if (processId) {
      yield* queueService.enqueue(PROCESS_EVENT_QUEUE, { processId })
    }

    yield* queueService.enqueue(EXECUTION_EVENT_QUEUE, {
      executionId: processExecutionId,
    })
  })

/**
 * Shared completion logic for system steps.
 *
 * Used by:
 * - The Lambda handler (for Completed results from inline execution)
 * - The Fargate entrypoint (after running step.execute() in the container)
 *
 * Performs: state update, todo completion, scheduled_flow insertion,
 * flow-execution enqueue, and event publishing.
 */
export const completeSystemStep = (params: {
  todoId: string
  stepPath: string
  output: Record<string, unknown>
  todoInfo: {
    createdAtMs: number
    orgUnitId: string
    processExecutionId: string
    processStateId: string
    barrierScheduledFlowId: string | null
    targetStepId: string
  }
  isForEach: boolean
  jobId: string
  queueService: QueueServiceType["Type"]
  completedJobOps: CompletedJobOperations["Type"]
  stepCompletionOps: StepCompletionOperations["Type"]
  scheduledFlowOps: ScheduledFlowOperations["Type"]
  flowExecutionOps: FlowExecutionOperations["Type"]
  calendarQueries: BusinessCalendarQueries["Type"]
  sqlClient: SqlClient.SqlClient
}) =>
  Effect.gen(function* () {
    const {
      todoId,
      stepPath,
      output,
      todoInfo,
      isForEach,
      jobId,
      queueService,
      completedJobOps,
      stepCompletionOps,
      scheduledFlowOps,
      flowExecutionOps,
      calendarQueries,
      sqlClient,
    } = params

    const dispatchId = systemStepTodoDispatchId(todoId)
    if (
      !queueService.queueInTransaction &&
      (yield* drainSystemStepFlowDispatch({
        dispatchId,
        queueService,
        flowExecutionOps,
      }))
    ) {
      return
    }

    // Get current time for completion
    const requestTime = yield* getRequestTime()
    const completedAtMs = DateTime.toEpochMillis(requestTime)

    // Calculate business duration for the step
    const businessDurationMs = yield* calculateStepBusinessDuration(
      sqlClient,
      calendarQueries,
      todoInfo.createdAtMs,
      completedAtMs,
      todoInfo.orgUnitId,
    )

    // Build the state update:
    // - forEach steps: append output to state[stepKey] array
    // - Regular steps: flat merge of output keys
    const stateUpdate = isForEach ? null : output
    const forEachStepKey = isForEach ? getForEachStepKey(stepPath) : null

    // All database operations in a single transaction
    const scheduledFlowId = yield* sqlClient.withTransaction(
      Effect.gen(function* () {
        // Update process state with the output
        if (forEachStepKey) {
          yield* stepCompletionOps.appendProcessStateArrayItem(
            todoInfo.processStateId,
            forEachStepKey,
            output,
          )
        } else if (stateUpdate && Object.keys(stateUpdate).length > 0) {
          yield* stepCompletionOps.updateProcessState(
            todoInfo.processStateId,
            stateUpdate,
          )
        }

        // Complete the todo with business duration
        // Note: For system steps, there is no user - pass null
        yield* stepCompletionOps.completeToDo(
          todoId,
          null, // System-executed, no user
          businessDurationMs,
        )

        // For forEach steps, use the barrier scheduled_flow created during fan-out.
        // For regular steps, create a new scheduled_flow for 2-phase commit.
        const scheduledFlowId = todoInfo.barrierScheduledFlowId
          ? todoInfo.barrierScheduledFlowId
          : yield* scheduledFlowOps.insertScheduledFlow(
              todoInfo.processExecutionId,
              todoInfo.targetStepId,
            )

        // For DB-backed queues, enqueue flow-execution job inside transaction
        // This ensures atomicity - if transaction rolls back, no job is enqueued
        if (queueService.queueInTransaction) {
          yield* queueService.enqueue(FLOW_EXECUTION_QUEUE, {
            scheduledFlowId,
          })
          yield* Effect.log("Flow scheduled after system step completion", {
            scheduledFlowId,
          })
        } else {
          yield* persistSystemStepFlowDispatch({
            dispatchId,
            processExecutionId: todoInfo.processExecutionId,
            scheduledFlowId,
            flowExecutionOps,
          })
        }

        // Mark job as completed (idempotency marker) - inside transaction
        yield* completedJobOps.markJobCompleted(
          SYSTEM_STEP_EXECUTION_QUEUE,
          jobId,
        )

        return scheduledFlowId
      }),
    )

    yield* recordSuccessfulStepCompletion("automated")

    // For external queues (SQS), enqueue flow-execution job after transaction commits
    // This ensures the scheduled_flow row is visible before the handler runs
    if (!queueService.queueInTransaction) {
      yield* drainSystemStepFlowDispatch({
        dispatchId,
        queueService,
        flowExecutionOps,
      })
      yield* Effect.log("Flow scheduled after system step completion", {
        scheduledFlowId,
      })
    }

    yield* enqueueTodoProcessExecutionEvents({
      todoId,
      processExecutionId: todoInfo.processExecutionId,
      queueService,
      flowExecutionOps,
    })
  })

/**
 * Complete an async system step atomically.
 *
 * Only the transaction that actually transitions the todo to completed will
 * persist the step output, schedule downstream flow execution, and publish
 * events. Duplicate or out-of-order callbacks therefore become no-ops.
 */
export const completeAsyncSystemStep = (params: {
  todoId: string
  stepPath: string
  output: Record<string, unknown>
  todoInfo: {
    createdAtMs: number
    orgUnitId: string
    processExecutionId: string
    processStateId: string
    barrierScheduledFlowId: string | null
    targetStepId: string
  }
  isForEach: boolean
  queueService: QueueServiceType["Type"]
  stepCompletionOps: StepCompletionOperations["Type"]
  scheduledFlowOps: ScheduledFlowOperations["Type"]
  flowExecutionOps: FlowExecutionOperations["Type"]
  calendarQueries: BusinessCalendarQueries["Type"]
  sqlClient: SqlClient.SqlClient
}) =>
  Effect.gen(function* () {
    const {
      todoId,
      stepPath,
      output,
      todoInfo,
      isForEach,
      queueService,
      stepCompletionOps,
      scheduledFlowOps,
      flowExecutionOps,
      calendarQueries,
      sqlClient,
    } = params

    const dispatchId = systemStepTodoDispatchId(todoId)
    if (
      !queueService.queueInTransaction &&
      (yield* drainSystemStepFlowDispatch({
        dispatchId,
        queueService,
        flowExecutionOps,
      }))
    ) {
      return true
    }

    const requestTime = yield* getRequestTime()
    const completedAtMs = DateTime.toEpochMillis(requestTime)

    const businessDurationMs = yield* calculateStepBusinessDuration(
      sqlClient,
      calendarQueries,
      todoInfo.createdAtMs,
      completedAtMs,
      todoInfo.orgUnitId,
    )

    const stateUpdate = isForEach ? null : output
    const forEachStepKey = isForEach ? getForEachStepKey(stepPath) : null

    const scheduledFlowId = yield* sqlClient.withTransaction(
      Effect.gen(function* () {
        const transitioned = yield* stepCompletionOps.completeAsyncToDo(
          todoId,
          null,
          businessDurationMs,
        )
        if (!transitioned) {
          return null
        }

        if (forEachStepKey) {
          yield* stepCompletionOps.appendProcessStateArrayItem(
            todoInfo.processStateId,
            forEachStepKey,
            output,
          )
        } else if (stateUpdate && Object.keys(stateUpdate).length > 0) {
          yield* stepCompletionOps.updateProcessState(
            todoInfo.processStateId,
            stateUpdate,
          )
        }

        const scheduledFlowId = todoInfo.barrierScheduledFlowId
          ? todoInfo.barrierScheduledFlowId
          : yield* scheduledFlowOps.insertScheduledFlow(
              todoInfo.processExecutionId,
              todoInfo.targetStepId,
            )

        if (queueService.queueInTransaction) {
          yield* queueService.enqueue(FLOW_EXECUTION_QUEUE, {
            scheduledFlowId,
          })
          yield* Effect.log(
            "Flow scheduled after async system step completion",
            {
              scheduledFlowId,
            },
          )
        } else {
          yield* persistSystemStepFlowDispatch({
            dispatchId,
            processExecutionId: todoInfo.processExecutionId,
            scheduledFlowId,
            flowExecutionOps,
          })
        }

        return scheduledFlowId
      }),
    )

    if (!scheduledFlowId) {
      return false
    }

    yield* recordSuccessfulStepCompletion("automated")

    if (!queueService.queueInTransaction) {
      yield* drainSystemStepFlowDispatch({
        dispatchId,
        queueService,
        flowExecutionOps,
      })
      yield* Effect.log("Flow scheduled after async system step completion", {
        scheduledFlowId,
      })
    }

    yield* enqueueTodoProcessExecutionEvents({
      todoId,
      processExecutionId: todoInfo.processExecutionId,
      queueService,
      flowExecutionOps,
    })

    return true
  })

type AsyncFailureResult =
  | { didFail: false }
  | { didFail: true; scheduledFlowId: string | null }

/**
 * Fail an async system step atomically.
 *
 * Failure remains non-terminal only until the todo is completed. Once the todo
 * has completed, later failure callbacks become no-ops.
 */
export const failAsyncSystemStep = (params: {
  todoId: string
  processExecutionId: string
  failureReason: string
  errorTag?: string
  queueService: QueueServiceType["Type"]
  stepCompletionOps: StepCompletionOperations["Type"]
  scheduledFlowOps: ScheduledFlowOperations["Type"]
  flowExecutionOps: FlowExecutionOperations["Type"]
  sqlClient: SqlClient.SqlClient
}) =>
  Effect.gen(function* () {
    const {
      todoId,
      processExecutionId,
      failureReason,
      errorTag,
      queueService,
      stepCompletionOps,
      scheduledFlowOps,
      flowExecutionOps,
      sqlClient,
    } = params

    const dispatchId = systemStepTodoDispatchId(todoId)
    if (!queueService.queueInTransaction) {
      const recoveredScheduledFlowId = yield* drainSystemStepFlowDispatch({
        dispatchId,
        queueService,
        flowExecutionOps,
      })
      if (recoveredScheduledFlowId) {
        return {
          didFail: true,
          scheduledFlowId: recoveredScheduledFlowId,
        } as const
      }
    }

    const todoInfo = yield* stepCompletionOps.queryTodoById(todoId)
    if (!todoInfo) {
      return { didFail: false } as const
    }

    const hasMatchingOnError = hasMatchingOnErrorFlow(
      yield* flowExecutionOps.queryFlowsBySourceStepId(todoInfo.targetStepId),
      errorTag,
    )

    const didFail: AsyncFailureResult = yield* sqlClient.withTransaction(
      Effect.gen(function* () {
        const didFail = yield* stepCompletionOps.failAsyncToDo(
          todoId,
          failureReason,
        )
        if (!didFail) {
          return { didFail: false } as const
        }

        if (hasMatchingOnError) {
          const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
            processExecutionId,
            todoInfo.targetStepId,
          )

          if (queueService.queueInTransaction) {
            yield* queueService.enqueue(FLOW_EXECUTION_QUEUE, {
              scheduledFlowId,
              onError: true,
              ...(errorTag !== undefined && { errorTag }),
            })
          } else {
            yield* persistSystemStepFlowDispatch({
              dispatchId,
              processExecutionId,
              scheduledFlowId,
              onError: true,
              ...(errorTag !== undefined && { errorTag }),
              flowExecutionOps,
            })
          }

          return { didFail: true, scheduledFlowId } as const
        }

        return { didFail: true, scheduledFlowId: null } as const
      }),
    )
    if (!didFail.didFail) {
      return didFail
    }

    if (!queueService.queueInTransaction && didFail.scheduledFlowId) {
      yield* drainSystemStepFlowDispatch({
        dispatchId,
        queueService,
        flowExecutionOps,
      })
    }

    yield* enqueueTodoProcessExecutionEvents({
      todoId,
      processExecutionId,
      queueService,
      flowExecutionOps,
    })

    return didFail
  })

type TerminalFailureResult =
  | { didFail: false }
  | {
      didFail: true
      scheduledFlowId: string | null
      closedExecution: boolean
    }

/**
 * Fail a terminal system step (Docker/Fargate completion callbacks).
 *
 * Unlike failAsyncSystemStep, a failure with no matching error branch is a
 * Terminal System Step Failure and marks the Process Execution Failed in the
 * same transaction as the Todo evidence.
 */
export const failTerminalSystemStep = (params: {
  todoId: string
  processExecutionId: string
  failureReason: string
  errorTag?: string
  completedJob?: {
    readonly ops: CompletedJobOperations["Type"]
    readonly namespace: string
    readonly jobId: string
  }
  queueService: QueueServiceType["Type"]
  stepCompletionOps: StepCompletionOperations["Type"]
  scheduledFlowOps: ScheduledFlowOperations["Type"]
  flowExecutionOps: FlowExecutionOperations["Type"]
  sqlClient: SqlClient.SqlClient
}) =>
  Effect.gen(function* () {
    const {
      todoId,
      processExecutionId,
      failureReason,
      errorTag,
      completedJob,
      queueService,
      stepCompletionOps,
      scheduledFlowOps,
      flowExecutionOps,
      sqlClient,
    } = params

    const dispatchId = systemStepTodoDispatchId(todoId)
    if (!queueService.queueInTransaction) {
      const recoveredScheduledFlowId = yield* drainSystemStepFlowDispatch({
        dispatchId,
        queueService,
        flowExecutionOps,
      })
      if (recoveredScheduledFlowId) {
        return {
          didFail: true,
          scheduledFlowId: recoveredScheduledFlowId,
          closedExecution: false,
        } as const
      }
    }

    const todoInfo = yield* stepCompletionOps.queryTodoById(todoId)
    if (!todoInfo) {
      if (completedJob) {
        yield* completedJob.ops.markJobCompleted(
          completedJob.namespace,
          completedJob.jobId,
        )
      }
      return { didFail: false } as const
    }

    const hasMatchingOnError = hasMatchingOnErrorFlow(
      yield* flowExecutionOps.queryFlowsBySourceStepId(todoInfo.targetStepId),
      errorTag,
    )

    const didFail: TerminalFailureResult = yield* sqlClient.withTransaction(
      Effect.gen(function* () {
        yield* stepCompletionOps.failToDo(todoId, failureReason)

        if (hasMatchingOnError) {
          const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
            processExecutionId,
            todoInfo.targetStepId,
          )

          if (queueService.queueInTransaction) {
            yield* queueService.enqueue(FLOW_EXECUTION_QUEUE, {
              scheduledFlowId,
              onError: true,
              ...(errorTag !== undefined && { errorTag }),
            })
          } else {
            yield* persistSystemStepFlowDispatch({
              dispatchId,
              processExecutionId,
              scheduledFlowId,
              onError: true,
              ...(errorTag !== undefined && { errorTag }),
              flowExecutionOps,
            })
          }

          if (completedJob) {
            yield* completedJob.ops.markJobCompleted(
              completedJob.namespace,
              completedJob.jobId,
            )
          }

          return {
            didFail: true,
            scheduledFlowId,
            closedExecution: false,
          } as const
        }

        yield* flowExecutionOps.setProcessExecutionFailed(
          processExecutionId,
          failureReason,
        )

        if (completedJob) {
          yield* completedJob.ops.markJobCompleted(
            completedJob.namespace,
            completedJob.jobId,
          )
        }

        return {
          didFail: true,
          scheduledFlowId: null,
          closedExecution: true,
        } as const
      }),
    )

    if (!didFail.didFail) {
      return didFail
    }

    if (!queueService.queueInTransaction && didFail.scheduledFlowId) {
      yield* drainSystemStepFlowDispatch({
        dispatchId,
        queueService,
        flowExecutionOps,
      })
    }

    yield* enqueueTodoProcessExecutionEvents({
      todoId,
      processExecutionId,
      queueService,
      flowExecutionOps,
    })

    return didFail
  })
