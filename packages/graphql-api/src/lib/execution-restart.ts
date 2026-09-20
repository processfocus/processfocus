import { randomUUID } from "node:crypto"
import { SqlClient } from "@effect/sql"
import { QueueService } from "@processfocus/runtime"
import { Effect, Option } from "effect"
import {
  CompletedJobOperations,
  EXECUTION_EVENT_QUEUE,
  ExecutionQueries,
  FlowExecutionOperations,
  PROCESS_EVENT_QUEUE,
  SYSTEM_STEP_EXECUTION_QUEUE,
  StepCompletionOperations,
  getStartedSystemStepCompletedJobId,
} from "@pf/graphql-db-operations"

/**
 * Stable outbox dispatch id for restarting a failed system-start execution.
 * Concurrent/retried GraphQL requests recover by draining this key.
 */
export const systemStartRestartDispatchId = (executionId: string) =>
  `execution-restart:${executionId}`

/**
 * Logical job id scoped to one restart attempt so delivery retries of the same
 * attempt dedupe while a later manual restart after another failure runs again.
 */
export const systemStartRestartLogicalJobId = (
  executionId: string,
  restartAttemptId: string,
) => `system-step:start-restart:${executionId}:${restartAttemptId}`

type RestartExecutionResult = {
  readonly success: boolean
  readonly restartedCount: number
  readonly error: string | null
}

/**
 * True when an external-queue restart attempt left undrained outbox rows.
 * Used by GraphQL restart and capability projection after post-commit send failure.
 *
 * Missing QueueService / FlowExecutionOperations layers return false so
 * projection filters stay usable in narrow test environments.
 */
export const hasPendingSystemStartRestartDispatch = (executionId: string) =>
  Effect.gen(function* () {
    const queueService = yield* Effect.serviceOption(QueueService)
    if (Option.isNone(queueService) || queueService.value.queueInTransaction) {
      return false
    }
    const flowExecutionOps = yield* Effect.serviceOption(
      FlowExecutionOperations,
    )
    if (Option.isNone(flowExecutionOps)) {
      return false
    }
    const pending = yield* flowExecutionOps.value.queryFlowDispatchJobs(
      systemStartRestartDispatchId(executionId),
    )
    return pending.length > 0
  })

const drainRestartDispatch = (params: {
  readonly dispatchId: string
  readonly queueService: QueueService["Type"]
  readonly flowExecutionOps: FlowExecutionOperations["Type"]
}) =>
  Effect.gen(function* () {
    const jobs = yield* params.flowExecutionOps.queryFlowDispatchJobs(
      params.dispatchId,
    )
    let drained = 0

    for (const job of jobs) {
      yield* params.queueService.enqueue(job.queue, job.payload, {
        logicalJobId: job.logicalJobId,
        ...(job.retryLimit === null ? {} : { retryLimit: job.retryLimit }),
      })
      yield* params.flowExecutionOps.deleteFlowDispatchJob(job.id)
      drained += 1
    }

    return drained
  })

/** Drop stale restart outbox rows without enqueueing (e.g. after a re-failure). */
const discardRestartDispatch = (params: {
  readonly dispatchId: string
  readonly flowExecutionOps: FlowExecutionOperations["Type"]
}) =>
  Effect.gen(function* () {
    const jobs = yield* params.flowExecutionOps.queryFlowDispatchJobs(
      params.dispatchId,
    )
    for (const job of jobs) {
      yield* params.flowExecutionOps.deleteFlowDispatchJob(job.id)
    }
  })

type ExternalDrainOutcome =
  | { readonly _tag: "Recovered" }
  | { readonly _tag: "DispatchIncomplete" }
  | { readonly _tag: "Abandoned" }
  /** Start re-failed (or still failed) after drain; caller must reopen. */
  | { readonly _tag: "NeedsReopen" }

/**
 * Post-conditions after draining restart outbox. Always re-reads execution state
 * so a re-failure during drain cannot be reported as a successful restart.
 */
const evaluateAfterExternalDrain = (params: {
  readonly executionId: string
  readonly dispatchId: string
  readonly flowExecutionOps: FlowExecutionOperations["Type"]
  readonly executionQueries: ExecutionQueries["Type"]
}) =>
  Effect.gen(function* () {
    const remaining = yield* params.flowExecutionOps.queryFlowDispatchJobs(
      params.dispatchId,
    )
    if (remaining.length > 0) {
      return {
        _tag: "DispatchIncomplete",
      } as const satisfies ExternalDrainOutcome
    }

    const current = (yield* params.executionQueries.getExecutions([
      params.executionId,
    ]))[0]
    if (current?.status === "Abandoned") {
      return { _tag: "Abandoned" } as const satisfies ExternalDrainOutcome
    }
    if (current?.status === "Failed") {
      return { _tag: "NeedsReopen" } as const satisfies ExternalDrainOutcome
    }
    // Running or Completed with empty outbox: dispatch recovery is done.
    return { _tag: "Recovered" } as const satisfies ExternalDrainOutcome
  })

const drainAndEvaluateExternal = (params: {
  readonly executionId: string
  readonly dispatchId: string
  readonly queueService: QueueService["Type"]
  readonly flowExecutionOps: FlowExecutionOperations["Type"]
  readonly executionQueries: ExecutionQueries["Type"]
}) =>
  Effect.gen(function* () {
    yield* drainRestartDispatch({
      dispatchId: params.dispatchId,
      queueService: params.queueService,
      flowExecutionOps: params.flowExecutionOps,
    })
    return yield* evaluateAfterExternalDrain({
      executionId: params.executionId,
      dispatchId: params.dispatchId,
      flowExecutionOps: params.flowExecutionOps,
      executionQueries: params.executionQueries,
    })
  })

const outcomeToResult = (
  outcome: ExternalDrainOutcome,
): RestartExecutionResult | null => {
  switch (outcome._tag) {
    case "Recovered":
      return { success: true, restartedCount: 1, error: null }
    case "DispatchIncomplete":
      return {
        success: false,
        restartedCount: 0,
        error: "Failed to dispatch restart jobs; retry restart",
      }
    case "Abandoned":
      return {
        success: false,
        restartedCount: 0,
        error: "Execution has been abandoned",
      }
    case "NeedsReopen":
      return null
  }
}

/**
 * Restart a Todo-less failed system-start execution.
 *
 * Reopens the execution-level failure representation, clears the stable start
 * completion marker, and re-enqueues the original start payload. External
 * queues persist an outbox row so post-commit send failure and accepted-response
 * loss can be recovered by re-draining the same dispatch id.
 */
export const restartFailedSystemStartExecution = (params: {
  readonly executionId: string
  readonly stepId: string
  readonly stepPath: string
  readonly processId: string | null
}) =>
  Effect.gen(function* () {
    const stepCompletionOps = yield* StepCompletionOperations
    const completedJobOps = yield* CompletedJobOperations
    const flowExecutionOps = yield* FlowExecutionOperations
    const executionQueries = yield* ExecutionQueries
    const queueService = yield* QueueService
    const sql = yield* SqlClient.SqlClient

    const dispatchId = systemStartRestartDispatchId(params.executionId)

    // Up to two reopen attempts: a concurrent start may re-fail between drain
    // recovery and a loser's status check, requiring another reopen.
    for (let reopenAttempt = 0; reopenAttempt < 2; reopenAttempt++) {
      const restartAttemptId = randomUUID()
      const logicalJobId = systemStartRestartLogicalJobId(
        params.executionId,
        restartAttemptId,
      )
      const startPayload = {
        startsProcess: true as const,
        processExecutionId: params.executionId,
        stepId: params.stepId,
        stepPath: params.stepPath,
      }

      const retryLimit = yield* flowExecutionOps.getStepRetryLimitByPath(
        params.stepPath,
      )
      const enqueueOptions = {
        logicalJobId,
        ...(retryLimit === null ? {} : { retryLimit }),
      }

      const enqueueStartAndEvents = Effect.gen(function* () {
        yield* queueService.enqueue(
          SYSTEM_STEP_EXECUTION_QUEUE,
          startPayload,
          enqueueOptions,
        )

        yield* queueService.enqueue(EXECUTION_EVENT_QUEUE, {
          executionId: params.executionId,
          processId: params.processId,
          eventType: "updated",
        })

        if (params.processId) {
          yield* queueService.enqueue(PROCESS_EVENT_QUEUE, {
            processId: params.processId,
            eventType: "updated",
          })
        }
      })

      const persistExternalRestartDispatch = Effect.gen(function* () {
        yield* flowExecutionOps.insertFlowDispatchJobs([
          {
            sourceScheduledFlowId: dispatchId,
            processExecutionId: params.executionId,
            logicalJobId,
            queue: SYSTEM_STEP_EXECUTION_QUEUE,
            payload: startPayload,
            retryLimit,
            scheduledAt: null,
            sequence: 0,
          },
          {
            sourceScheduledFlowId: dispatchId,
            processExecutionId: params.executionId,
            logicalJobId: `execution-event:restart:${params.executionId}:${restartAttemptId}`,
            queue: EXECUTION_EVENT_QUEUE,
            payload: {
              executionId: params.executionId,
              processId: params.processId,
              eventType: "updated",
            },
            retryLimit: null,
            scheduledAt: null,
            sequence: 1,
          },
          ...(params.processId
            ? [
                {
                  sourceScheduledFlowId: dispatchId,
                  processExecutionId: params.executionId,
                  logicalJobId: `process-event:restart:${params.processId}:${restartAttemptId}`,
                  queue: PROCESS_EVENT_QUEUE,
                  payload: {
                    processId: params.processId,
                    eventType: "updated",
                  },
                  retryLimit: null,
                  scheduledAt: null,
                  sequence: 2,
                },
              ]
            : []),
        ])
      })

      // External recovery: drain pending outbox when not abandoned. Failed status
      // with leftover outbox must fall through to reopen (do not discard outside
      // the reopen transaction — that races with a concurrent winner's fresh
      // outbox under the same stable dispatch id).
      if (!queueService.queueInTransaction) {
        const pending =
          yield* flowExecutionOps.queryFlowDispatchJobs(dispatchId)
        if (pending.length > 0) {
          const current = (yield* executionQueries.getExecutions([
            params.executionId,
          ]))[0]
          if (current?.status === "Abandoned") {
            return {
              success: false,
              restartedCount: 0,
              error: "Execution has been abandoned",
            } satisfies RestartExecutionResult
          }

          // Running or Completed: pure dispatch recovery (no reopen).
          // Completed covers leftover event rows after a successful start.
          if (
            current?.status === "Running" ||
            current?.status === "Completed"
          ) {
            const outcome = yield* drainAndEvaluateExternal({
              executionId: params.executionId,
              dispatchId,
              queueService,
              flowExecutionOps,
              executionQueries,
            })
            const asResult = outcomeToResult(outcome)
            if (asResult !== null) {
              return asResult
            }
            // NeedsReopen: start re-failed during drain; open a new attempt.
          }
          // Failed (+ leftover outbox): fall through to reopen.
        }
      }

      const reopened = yield* sql.withTransaction(
        Effect.gen(function* () {
          const didReopen =
            yield* stepCompletionOps.reopenFailedSystemStartExecution(
              params.executionId,
            )
          if (!didReopen) {
            return false
          }

          // Allow the start worker to process again for this execution.
          yield* completedJobOps.clearJobCompleted(
            SYSTEM_STEP_EXECUTION_QUEUE,
            getStartedSystemStepCompletedJobId(params.executionId),
          )

          if (queueService.queueInTransaction) {
            yield* enqueueStartAndEvents
          } else {
            // Atomically replace any leftover attempt under this dispatch id.
            yield* discardRestartDispatch({
              dispatchId,
              flowExecutionOps,
            })
            yield* persistExternalRestartDispatch
          }

          return true
        }),
      )

      if (reopened) {
        if (!queueService.queueInTransaction) {
          const outcome = yield* drainAndEvaluateExternal({
            executionId: params.executionId,
            dispatchId,
            queueService,
            flowExecutionOps,
            executionQueries,
          })
          const asResult = outcomeToResult(outcome)
          if (asResult !== null) {
            return asResult
          }
          // NeedsReopen after our own reopen: rare re-fail during drain; retry.
          continue
        }

        return {
          success: true,
          restartedCount: 1,
          error: null,
        } satisfies RestartExecutionResult
      }

      // Concurrent request lost the reopen race.
      if (!queueService.queueInTransaction) {
        const current = (yield* executionQueries.getExecutions([
          params.executionId,
        ]))[0]
        if (current?.status === "Abandoned") {
          return {
            success: false,
            restartedCount: 0,
            error: "Execution has been abandoned",
          } satisfies RestartExecutionResult
        }

        if (current?.status === "Running" || current?.status === "Completed") {
          const pending =
            yield* flowExecutionOps.queryFlowDispatchJobs(dispatchId)
          if (pending.length > 0) {
            const outcome = yield* drainAndEvaluateExternal({
              executionId: params.executionId,
              dispatchId,
              queueService,
              flowExecutionOps,
              executionQueries,
            })
            const asResult = outcomeToResult(outcome)
            if (asResult !== null) {
              return asResult
            }
            // NeedsReopen: concurrent start re-failed; try another reopen.
            continue
          }

          // No outbox: winner finished. Marker clear proves reopen happened.
          const stillCompleted = yield* completedJobOps.isJobCompleted(
            SYSTEM_STEP_EXECUTION_QUEUE,
            getStartedSystemStepCompletedJobId(params.executionId),
          )
          if (!stillCompleted || current.status === "Completed") {
            return {
              success: true,
              restartedCount: 1,
              error: null,
            } satisfies RestartExecutionResult
          }
        }

        if (current?.status === "Failed") {
        }
      } else {
        // DB-backed queue: enqueue was transactional with reopen.
        const stillCompleted = yield* completedJobOps.isJobCompleted(
          SYSTEM_STEP_EXECUTION_QUEUE,
          getStartedSystemStepCompletedJobId(params.executionId),
        )
        if (!stillCompleted) {
          return {
            success: true,
            restartedCount: 1,
            error: null,
          } satisfies RestartExecutionResult
        }
      }
    }

    return {
      success: false,
      restartedCount: 0,
      error: "No failed todos found for this execution",
    } satisfies RestartExecutionResult
  })
