import { randomUUID } from "node:crypto"
import { QueueService } from "@processfocus/runtime"
import { DateTime, Duration, Effect } from "effect"
import { SqlClient } from "effect/sql"
import { recordDeploymentAudit } from "@pf/audit/deployment"
import {
  Execution as AuthExecution,
  AuthorizationService,
} from "@pf/auth-policy"
import { withImmediateTransaction } from "@pf/db-info"
import {
  EXECUTION_EVENT_QUEUE,
  ExecutionQueries,
  FLOW_EXECUTION_QUEUE,
  FlowExecutionOperations,
  PROCESS_EVENT_QUEUE,
  SYSTEM_STEP_EXECUTION_QUEUE,
  ScheduledFlowOperations,
  StepCompletionOperations,
  TODO_EVENT_QUEUE,
  getUserDetails,
} from "@pf/graphql-db-operations"
import { OrganisationProvider } from "@pf/process"
import { buildStepPrincipal } from "./authorization"
import {
  checkExecutionAbandonAuthorization,
  isAbandonableExecutionStatus,
} from "./execution-abandon-authorization"
import {
  hasPendingSystemStartRestartDispatch,
  restartFailedSystemStartExecution,
} from "./execution-restart"
import type { ExecutionIdentity } from "./identity"
import { runProcessActivation } from "./process-activation"
export const restartExecution = (args: {
  readonly executionId: string
  readonly identity: ExecutionIdentity
}) =>
  Effect.gen(function* () {
    const auth = yield* AuthorizationService
    const executionQueries = yield* ExecutionQueries
    const stepCompletionOps = yield* StepCompletionOperations
    const flowExecutionOps = yield* FlowExecutionOperations
    const queueService = yield* QueueService
    const sql = yield* SqlClient.SqlClient

    const executions = yield* executionQueries.getExecutions([args.executionId])
    const execution = executions[0]
    if (!execution) {
      return {
        success: false,
        restartedCount: 0,
        error: `Execution not found: ${args.executionId}`,
      }
    }

    const principal = yield* buildStepPrincipal(args.identity)
    const resource = new AuthExecution(
      args.executionId,
      execution.startedByEmail,
      execution.processPath,
      [], // empty orgUnitPaths - only checking startedBy
    )

    const canRestart = yield* auth.canRestartExecution(principal, resource)
    if (!canRestart) {
      return {
        success: false,
        restartedCount: 0,
        error: "Not authorized to restart this execution",
      }
    }

    const failedTodos = yield* stepCompletionOps.queryFailedTodosForExecution(
      args.executionId,
    )

    // 5. Get process ID for events
    const processId = yield* flowExecutionOps.getProcessIdForExecution(
      args.executionId,
    )

    const enqueuePendingDeadlines = Effect.gen(function* () {
      const schedules = yield* ScheduledFlowOperations
      const pendingDeadlines = yield* schedules.queryPendingTaskDeadlines(
        args.executionId,
      )
      const now = yield* DateTime.now
      for (const deadline of pendingDeadlines) {
        const delay =
          deadline.withoutWaiting ||
          DateTime.isLessThanOrEqualTo(deadline.scheduledAt, now)
            ? Duration.zero
            : Duration.abs(DateTime.distance(now, deadline.scheduledAt))
        yield* queueService.enqueueWithDelay(
          FLOW_EXECUTION_QUEUE,
          { scheduledFlowId: deadline.id },
          delay,
        )
      }
      return pendingDeadlines.length
    })

    // 5b. Todo-less system-start restart:
    // - Failed roleless start (execution-level failure, no Todo), or
    // - Pending external restart outbox after reopen committed but SQS
    //   drain failed (status is already Running; sequential GraphQL retry
    //   must still recover the outbox).
    if (failedTodos.length === 0) {
      // An external send may fail after reopening committed. The pending
      // attachment/handoff remains the durable retry source.
      if (
        execution.status === "Running" &&
        (yield* enqueuePendingDeadlines) > 0
      ) {
        return { success: true, restartedCount: 0, error: null }
      }
      const isRolelessStart = execution.startStepRoleId === null
      const isFailedSystemStart =
        execution.status === "Failed" &&
        isRolelessStart &&
        execution.abandonedReason != null

      const pendingExternalRestart =
        isRolelessStart &&
        execution.status !== "Abandoned" &&
        (yield* hasPendingSystemStartRestartDispatch(args.executionId))

      if (!isFailedSystemStart && !pendingExternalRestart) {
        return {
          success: false,
          restartedCount: 0,
          error: "No failed todos found for this execution",
        }
      }

      return yield* restartFailedSystemStartExecution({
        executionId: args.executionId,
        stepId: execution.startStepId,
        stepPath: execution.startStepPath,
        processId,
      })
    }

    // Helper to enqueue all jobs (system step re-execution + event notifications)
    const enqueueJobs = (todos: typeof failedTodos) =>
      Effect.gen(function* () {
        // Enqueue system-step-execution jobs for each failed system step
        for (const todo of todos.filter((t) => t.isSystemStep)) {
          const retryLimit = yield* flowExecutionOps.getStepRetryLimitByPath(
            todo.stepPath,
          )
          yield* queueService.enqueue(
            SYSTEM_STEP_EXECUTION_QUEUE,
            {
              todoId: todo.todoId,
              stepPath: todo.stepPath,
              processExecutionId: args.executionId,
            },
            {
              logicalJobId: `system-step:${todo.todoId}`,
              ...(retryLimit === null ? {} : { retryLimit }),
            },
          )
        }

        // Delivery during failure leaves deadline handoffs pending. Restart
        // re-delivers those same identities at their original due times.
        yield* enqueuePendingDeadlines

        // Publish event notifications
        if (todos.length > 0) {
          yield* queueService.enqueue(TODO_EVENT_QUEUE, {
            todoIds: todos.map((t) => t.todoId),
          })
        }

        yield* queueService.enqueue(EXECUTION_EVENT_QUEUE, {
          executionId: args.executionId,
          processId,
          eventType: "updated",
        })

        yield* queueService.enqueue(PROCESS_EVENT_QUEUE, {
          processId,
          eventType: "updated",
        })
      })

    const { organisation } = yield* OrganisationProvider
    const validateActivation = organisation.stepByPath(execution.startStepPath)
      ?.process.props.validateActivation

    // Reset and validate under the same writer transaction as admission.
    const restart = Effect.gen(function* () {
      // Another restart can consume the same failures while this request
      // waits for the writer. Re-read before clearing or dispatching them.
      const todos = validateActivation
        ? yield* stepCompletionOps.queryFailedTodosForExecution(
            args.executionId,
          )
        : failedTodos
      if (todos.length === 0) return []

      // Clear todo failures
      yield* stepCompletionOps.clearTodoFailures(
        todos.map((t) => t.todoId),
        randomUUID(),
      )

      // Clear execution finished status
      yield* stepCompletionOps.clearProcessExecutionFinished(args.executionId)

      if (validateActivation) {
        const state = yield* executionQueries.getProcessStateByExecutionId(
          args.executionId,
        )
        yield* runProcessActivation(validateActivation, {
          kind: "activation",
          executionId: args.executionId,
          state: state ?? {},
        })
      }

      // For DB-backed queues, enqueue inside transaction to avoid lock contention
      if (queueService.queueInTransaction) {
        yield* enqueueJobs(todos)
      }
      return todos
    })
    const admission = yield* (
      validateActivation
        ? withImmediateTransaction(sql, restart)
        : sql.withTransaction(restart)
    ).pipe(
      Effect.map((todos) => ({ todos })),
      Effect.catchTags({
        FormSubmissionError: (error) =>
          Effect.succeed({ error: error.message }),
        ProcessActivationConflict: (error) =>
          Effect.succeed({ error: error.message }),
      }),
    )
    if ("error" in admission)
      return { success: false, restartedCount: 0, error: admission.error }
    if (admission.todos.length === 0)
      return {
        success: false,
        restartedCount: 0,
        error: "No failed todos found for this execution",
      }

    yield* recordDeploymentAudit(args.executionId, {
      subtype: "restarted",
      actor: yield* getUserDetails(),
    })

    // For external queues (SQS), enqueue after transaction commits
    // to ensure data is visible in the database before handlers run
    if (!queueService.queueInTransaction) {
      yield* enqueueJobs(admission.todos)
    }

    return {
      success: true,
      restartedCount: admission.todos.length,
      error: null,
    }
  })
export const abandonExecution = (args: {
  readonly executionId: string
  readonly reason?: string | null
  readonly identity: ExecutionIdentity
}) =>
  Effect.gen(function* () {
    const executionQueries = yield* ExecutionQueries
    const stepCompletionOps = yield* StepCompletionOperations
    const scheduledFlowOps = yield* ScheduledFlowOperations
    const flowExecutionOps = yield* FlowExecutionOperations
    const queueService = yield* QueueService
    const sqlClient = yield* SqlClient.SqlClient

    const executions = yield* executionQueries.getExecutions([args.executionId])
    const execution = executions[0]
    if (!execution) {
      return {
        success: false,
        error: `Execution not found: ${args.executionId}`,
      }
    }

    // 2. Check abandonable status
    if (!isAbandonableExecutionStatus(execution.status)) {
      return {
        success: false,
        error: "Only running or failed executions can be abandoned",
      }
    }

    const principal = yield* buildStepPrincipal(args.identity)

    // 4. Step-based authorization check
    const abandonAuthorization = yield* checkExecutionAbandonAuthorization(
      principal,
      args.executionId,
      execution.status,
      { startStepPath: execution.startStepPath },
    )

    if (!abandonAuthorization.hasAbandonableSteps) {
      return {
        success: false,
        error: "No active steps found for this execution",
      }
    }

    if (!abandonAuthorization.authorized) {
      return {
        success: false,
        error: "Not authorized to abandon this execution",
      }
    }

    // 5. Get processId for events
    const processId = yield* flowExecutionOps.getProcessIdForExecution(
      args.executionId,
    )

    // 6. In transaction: abandon execution, soft-delete todos, delete scheduled flows
    const deletedTodoIds = yield* sqlClient.withTransaction(
      Effect.gen(function* () {
        yield* stepCompletionOps.setProcessExecutionAbandoned(
          args.executionId,
          args.reason ?? undefined,
        )
        const todoIds =
          yield* stepCompletionOps.softDeleteActiveTodosForExecution(
            args.executionId,
          )
        yield* scheduledFlowOps.deleteScheduledFlowsForExecution(
          args.executionId,
        )

        return todoIds
      }),
    )

    yield* recordDeploymentAudit(args.executionId, {
      subtype: "failed",
      summary: "Deployment cancelled",
    })

    // 7. Enqueue event notifications after transaction commits
    yield* Effect.gen(function* () {
      yield* queueService.enqueue(EXECUTION_EVENT_QUEUE, {
        executionId: args.executionId,
        processId,
        eventType: "updated",
      })

      // Only enqueue todo events if there were deleted todos
      if (deletedTodoIds.length > 0) {
        yield* queueService.enqueue(TODO_EVENT_QUEUE, {
          todoIds: deletedTodoIds,
        })
      }

      yield* queueService.enqueue(PROCESS_EVENT_QUEUE, {
        processId,
        eventType: "updated",
      })
    })

    return {
      success: true,
      error: null,
    }
  })
