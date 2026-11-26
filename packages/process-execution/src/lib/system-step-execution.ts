import { randomUUID } from "node:crypto"
import { QueueService, isJobAttemptCurrent } from "@processfocus/runtime"
import {
  Cause,
  Config,
  Data,
  DateTime,
  Duration,
  Effect,
  Exit,
  Option,
  Schema,
} from "effect"
import { SqlClient } from "effect/sql"
import { recordDeploymentAudit } from "@pf/audit/deployment"
import { recordSuccessfulStepCompletion } from "@pf/business-metrics"
import { withReadSnapshot } from "@pf/db-info"
import {
  BusinessCalendarQueries,
  CompletedJobOperations,
  EXECUTION_EVENT_QUEUE,
  FLOW_EXECUTION_QUEUE,
  FlowExecutionOperations,
  PROCESS_EVENT_QUEUE,
  SYSTEM_STEP_EXECUTION_QUEUE,
  ScheduledFlowOperations,
  StepCompletionOperations,
  TODO_EVENT_QUEUE,
  UserDetails,
  decodeDelegationAudit,
  getStartedSystemStepCompletedJobId,
  withUserDetailsScope,
} from "@pf/graphql-db-operations"
import {
  SystemStepExecutor,
  buildFlowContext,
  isNonRetryableAuthorError,
} from "@pf/process"
import {
  InvalidProcessStateError,
  ProcessExecutionNotFoundError,
  ProcessStateNotFoundError,
  RetryBudgetExceededError,
} from "../errors"
import { completeSystemStep } from "./complete-system-step"
import type { ExecutionDelivery as Job } from "./delivery"
import { enqueueExecutionFailureNotificationJobs } from "./execution-failure-notifications"
import { hasMatchingOnErrorFlow } from "./on-error-routing"
import { reportSystemStepCompletion } from "./report-system-step-completion"
import {
  drainSystemStepFlowDispatch,
  isSystemStepFlowDispatchError,
  persistSystemStepFlowDispatch,
  startedSystemStepDispatchId,
  systemStepTodoDispatchId,
} from "./system-step-flow-dispatch"

const SYSTEM_STEP_EXECUTION_TIMEOUT_SECONDS_ENV =
  "SYSTEM_STEP_EXECUTION_TIMEOUT_SECONDS"

class SystemStepExecutionTimeoutError extends Data.TaggedError(
  "SystemStepExecutionTimeoutError",
)<{
  readonly message: string
  readonly stepPath: string
  readonly timeoutSeconds: number
}> {}

/**
 * Schema for system-step-execution queue job payloads.
 */
const SystemStepTodoPayloadSchema = Schema.Struct({
  todoId: Schema.String,
  stepPath: Schema.String,
})

const StartSystemStepExecutionPayloadSchema = Schema.Struct({
  startsProcess: Schema.Literal(true),
  processExecutionId: Schema.String,
  stepId: Schema.String,
  stepPath: Schema.String,
})

export const SystemStepExecutionPayloadSchema = Schema.Union([
  SystemStepTodoPayloadSchema,
  StartSystemStepExecutionPayloadSchema,
])

export type SystemStepExecutionPayload =
  typeof SystemStepExecutionPayloadSchema.Type

type SystemStepTodoPayload = typeof SystemStepTodoPayloadSchema.Type
type StartSystemStepExecutionPayload =
  typeof StartSystemStepExecutionPayloadSchema.Type

const ProcessStateSchema = Schema.Unknown.check(
  Schema.makeFilter(
    (value) =>
      typeof value === "object" && value !== null && !Array.isArray(value),
  ),
).pipe(Schema.decodeTo(Schema.Record(Schema.String, Schema.Unknown)))

const isTodoPayload = (
  payload: SystemStepExecutionPayload,
): payload is SystemStepTodoPayload => "todoId" in payload

const getPayloadContext = (payload: SystemStepExecutionPayload) =>
  isTodoPayload(payload)
    ? { todoId: payload.todoId }
    : {
        processExecutionId: payload.processExecutionId,
        stepPath: payload.stepPath,
      }

const isSystemStepExecutionFailure = (
  error: unknown,
): error is {
  readonly _tag: "SystemStepExecutionError"
  readonly error?: unknown
} =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  (error as { _tag?: unknown })._tag === "SystemStepExecutionError"

/**
 * Author-facing failure value used for retry classification.
 * SystemStepExecutionError is a reserved envelope; inspect its inner error.
 */
const authorFacingFailure = (cause: Cause.Cause<unknown>): unknown => {
  const failureValue = Option.getOrUndefined(Cause.findErrorOption(cause))
  return isSystemStepExecutionFailure(failureValue)
    ? failureValue.error
    : failureValue
}

/**
 * True when the step should fail the todo immediately instead of retrying.
 * Covers Effect defects and tagged failures that set `retryable: false`.
 */
const isTerminalStepFailure = (cause: Cause.Cause<unknown>): boolean => {
  if (cause.reasons.some(Cause.isDieReason)) {
    return true
  }
  return isNonRetryableAuthorError(authorFacingFailure(cause))
}

const formatExecutionFailure = (cause: Cause.Cause<unknown>) => {
  const fullFailureReason = Cause.pretty(cause)

  const failureValue = Option.getOrUndefined(Cause.findErrorOption(cause))
  // Only unwrap the reserved SystemStepExecutionError envelope for the
  // "Caused by" suffix; plain tagged failures already render in Cause.pretty.
  const innerError = isSystemStepExecutionFailure(failureValue)
    ? failureValue.error
    : undefined

  const innerErrorText = (() => {
    if (innerError == null) return null
    if (typeof innerError === "string") return innerError
    if (innerError instanceof Error) {
      return `${innerError.name}: ${innerError.message}`
    }
    if (typeof innerError === "object") {
      const err = innerError as {
        _tag?: string
        message?: string
        cause?: unknown
      }
      const tag = err._tag
      const msg = err.message
      const errorCause = err.cause
      if (msg) {
        const tagPrefix = tag ? `[${tag}] ` : ""
        const causeSuffix = errorCause ? ` (cause: ${String(errorCause)})` : ""
        return `${tagPrefix}${msg}${causeSuffix}`
      }
    }
    return String(innerError)
  })()

  return {
    fullFailureReason,
    innerErrorText,
    displayFailureReason: innerErrorText
      ? `${fullFailureReason}\nCaused by: ${innerErrorText}`
      : fullFailureReason,
    isTerminal: isTerminalStepFailure(cause),
  }
}

const getTaggedFailureTag = (candidate: unknown): string | undefined => {
  if (
    candidate &&
    typeof candidate === "object" &&
    "_tag" in candidate &&
    typeof (candidate as { _tag?: unknown })._tag === "string"
  ) {
    const tag = (candidate as { _tag: string })._tag

    // SystemStepExecutionError is a reserved/internal envelope tag (legacy or
    // external). Treat it as untagged so catch-all onError branches handle it
    // instead of matching the envelope type itself. Author domain failures
    // pass through as their own AuthorTaggedError tags.
    return tag === "SystemStepExecutionError" ? undefined : tag
  }

  return undefined
}

const extractOutermostErrorTag = (
  cause: Cause.Cause<unknown>,
): string | undefined => {
  const failureValue = Option.getOrUndefined(Cause.findErrorOption(cause))
  const failureTag = getTaggedFailureTag(failureValue)
  if (failureTag !== undefined) {
    return failureTag
  }

  // Tagged defects are treated like domain failures here so authors can still
  // route thrown tagged errors through onError branches.
  return cause.reasons
    .filter(Cause.isDieReason)
    .map((reason) => reason.defect)
    .map(getTaggedFailureTag)
    .find((tag): tag is string => tag !== undefined)
}

const withConfiguredSystemStepTimeout = <A, E, R>(
  stepPath: string,
  effect: Effect.Effect<A, E, R>,
) =>
  Config.option(Config.Number(SYSTEM_STEP_EXECUTION_TIMEOUT_SECONDS_ENV)).pipe(
    Effect.flatMap((timeoutSecondsOption) => {
      if (Option.isNone(timeoutSecondsOption)) {
        return effect
      }

      const timeoutSeconds = timeoutSecondsOption.value
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
        return effect
      }

      return effect.pipe(
        Effect.timeoutOrElse({
          duration: Duration.seconds(timeoutSeconds),
          orElse: () =>
            Effect.fail(
              new SystemStepExecutionTimeoutError({
                message: `System step execution exceeded configured timeout of ${timeoutSeconds} seconds`,
                stepPath,
                timeoutSeconds,
              }),
            ),
        }),
      )
    }),
  )

/**
 * Record a todo failure on the last attempt when an infrastructure error
 * (e.g. ProcessStateNotFoundError, SQL errors) escapes the inner handler.
 *
 * If failure recording itself fails (unlikely — means DB is down), we log
 * and let the error propagate so the job is dead-lettered.
 */
const recordInfrastructureFailure = (
  job: Job<SystemStepExecutionPayload>,
  errorDescription: string,
) =>
  Effect.gen(function* () {
    if (!isTodoPayload(job.payload)) {
      return yield* recordStartedSystemStepFailure(
        job as Job<StartSystemStepExecutionPayload>,
        errorDescription,
      )
    }

    const { todoId } = job.payload
    const completedJobOps = yield* CompletedJobOperations
    const stepCompletionOps = yield* StepCompletionOperations
    const flowExecutionOps = yield* FlowExecutionOperations
    const queueService = yield* QueueService
    const sqlClient = yield* SqlClient.SqlClient

    const failureReason =
      errorDescription.length > 500
        ? `${errorDescription.slice(0, 497)}...`
        : errorDescription

    yield* Effect.logError(
      "Infrastructure error on last attempt, recording todo failure",
      {
        todoId,
        jobId: job.jobId,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        isTerminal: true,
        failureReason,
      },
    )

    // Record the Todo failure and close the execution in one transaction so
    // an unhandled last-attempt infrastructure error cannot leave the run open.
    const failedExecutionId = yield* sqlClient.withTransaction(
      Effect.gen(function* () {
        if (!(yield* isJobAttemptCurrent)) return
        yield* stepCompletionOps.failToDo(todoId, failureReason)
        const todoInfo = yield* stepCompletionOps.queryTodoById(todoId)
        if (todoInfo) {
          yield* flowExecutionOps.setProcessExecutionFailed(
            todoInfo.processExecutionId,
            failureReason,
          )
        }
        yield* completedJobOps.markJobCompleted(
          SYSTEM_STEP_EXECUTION_QUEUE,
          job.jobId,
        )
        return todoInfo?.processExecutionId
      }),
    )

    if (failedExecutionId) {
      yield* recordDeploymentAudit(failedExecutionId, { subtype: "failed" })
    }

    // Publish AFTER commit so clients see the failure.
    yield* queueService.enqueue(TODO_EVENT_QUEUE, {
      todoIds: [todoId],
    })

    // Best-effort: look up processExecutionId from the todo
    const todoInfo = yield* stepCompletionOps.queryTodoById(todoId)
    if (todoInfo) {
      const processId = yield* flowExecutionOps.getProcessIdForExecution(
        todoInfo.processExecutionId,
      )
      if (processId) {
        yield* queueService.enqueue(PROCESS_EVENT_QUEUE, { processId })
      }
      yield* queueService.enqueue(EXECUTION_EVENT_QUEUE, {
        executionId: todoInfo.processExecutionId,
      })
      yield* enqueueExecutionFailureNotificationJobs({
        processExecutionId: todoInfo.processExecutionId,
        stepPath: job.payload.stepPath,
        failureReason,
      })
    }
  })

const recordStartedSystemStepFailure = (
  job: Job<StartSystemStepExecutionPayload>,
  errorDescription: string,
) =>
  Effect.gen(function* () {
    const { processExecutionId, stepPath } = job.payload
    const completedJobId =
      getStartedSystemStepCompletedJobId(processExecutionId)
    const completedJobOps = yield* CompletedJobOperations
    const flowExecutionOps = yield* FlowExecutionOperations
    const queueService = yield* QueueService
    const sqlClient = yield* SqlClient.SqlClient

    const failureReason =
      errorDescription.length > 500
        ? `${errorDescription.slice(0, 497)}...`
        : errorDescription

    yield* Effect.logError(
      "Start system step failed on last attempt, finishing execution",
      {
        processExecutionId,
        stepPath,
        jobId: job.jobId,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        isTerminal: true,
        failureReason,
      },
    )

    yield* sqlClient.withTransaction(
      Effect.gen(function* () {
        if (!(yield* isJobAttemptCurrent)) return
        yield* completedJobOps.markJobCompleted(
          SYSTEM_STEP_EXECUTION_QUEUE,
          completedJobId,
        )
        yield* flowExecutionOps.setProcessExecutionFailed(
          processExecutionId,
          failureReason,
        )
      }),
    )

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
 * Handler for system-step-execution queue jobs.
 *
 * This handler executes SystemSteps (steps with no role) automatically.
 * These are business logic steps that don't require user interaction.
 *
 * Failure semantics are intentionally generic and follow Effect channel
 * conventions rather than plugin-specific tags:
 * - Tagged / expected errors on the failure channel are treated as retryable
 *   unless they set `retryable: false`. Retryable failures are re-thrown until
 *   the retry budget is exhausted, then recorded as a failed todo. Without a
 *   matching onError branch the Process Execution is Failed in that same
 *   transaction.
 * - Tagged failures with `retryable: false` (deterministic validation or
 *   unsupported-operation refusals) are recorded immediately without delayed
 *   retries, and close the execution unless an onError branch matches.
 * - Defects on the defect channel are treated as non-retryable setup/runtime
 *   faults and are recorded immediately, closing the execution unless an
 *   onError branch matches.
 *
 * Plugin authors should therefore:
 * - use `Effect.fail(...)` / tagged errors for ordinary step failures that may
 *   succeed on retry or should participate in normal onError routing.
 * - set `retryable: false` on tagged errors for deterministic refusals that
 *   will not succeed on retry (validation, unsupported engine/ops).
 * - use `Effect.die(...)`, `Effect.orDie`, or otherwise move failures onto the
 *   defect channel for deployment/configuration/programming faults that should
 *   fail the step immediately.
 *
 * The flow is:
 * 1. Check idempotency (completed_job table)
 * 2. Get todo info and process state
 * 3. Build FlowContext from completed steps
 * 4. Call SystemStepExecutor.execute(stepPath, state, ctx)
 * 5. Update process state with output
 * 6. Complete todo (mark as completed, set businessDuration)
 * 7. Insert scheduled_flow and enqueue flow-execution job
 * 8. Enqueue event jobs (todo, process, execution)
 *
 * An outer wrapper catches infrastructure errors (SQL failures,
 * ProcessStateNotFoundError, etc.) that escape the inner logic. On the
 * last attempt it records a todo failure so the execution doesn't stay
 * stuck in "Running" forever.
 */
const handleSystemStepExecution = Effect.fn("system-step-execution")(
  (job: Job<SystemStepExecutionPayload>) =>
    handleSystemStepExecutionInner(job).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          // Always rethrow dispatch persistence failures so the job retries.
          if (isSystemStepFlowDispatchError(error)) {
            return yield* Effect.fail(error)
          }
          // Let the queue retry while attempts remain.
          if (job.attempts < job.maxAttempts) {
            return yield* Effect.fail(error)
          }

          const description = `Exhausted ${job.maxAttempts} retries: ${String(error)}`
          yield* recordInfrastructureFailure(job, description).pipe(
            Effect.catchCause((recordingCause) =>
              Effect.logError(
                "Failed to record infrastructure failure on system step",
                {
                  ...getPayloadContext(job.payload),
                  recordingError: Cause.pretty(recordingCause),
                },
              ),
            ),
          )
        }),
      ),
      Effect.catchDefect((defect) =>
        Effect.gen(function* () {
          if (job.attempts < job.maxAttempts) {
            return yield* Effect.die(defect)
          }

          const description = `Exhausted ${job.maxAttempts} retries (defect): ${String(defect)}`
          yield* recordInfrastructureFailure(job, description).pipe(
            Effect.catchCause((recordingCause) =>
              Effect.logError(
                "Failed to record infrastructure defect on system step",
                {
                  ...getPayloadContext(job.payload),
                  recordingError: Cause.pretty(recordingCause),
                },
              ),
            ),
          )
        }),
      ),
    ),
)

/**
 * Handles the ordinary todo-backed system step path.
 */
const handleTodoSystemStepExecution = (job: Job<SystemStepTodoPayload>) =>
  Effect.gen(function* () {
    const { todoId, stepPath } = job.payload
    const queueService = yield* QueueService
    const flowExecutionOps = yield* FlowExecutionOperations
    const completedJobOps = yield* CompletedJobOperations
    const dispatchId = systemStepTodoDispatchId(todoId)

    const recoveredDispatch =
      !queueService.queueInTransaction &&
      (yield* drainSystemStepFlowDispatch({
        dispatchId,
        queueService,
        flowExecutionOps,
      }))

    if (
      recoveredDispatch &&
      (yield* completedJobOps.isJobCompleted(
        SYSTEM_STEP_EXECUTION_QUEUE,
        job.jobId,
      ))
    ) {
      return
    }

    // Guard: if we've exceeded the retry budget, fail immediately regardless
    // of whether the step would succeed.
    //
    // NOTE: This is primarily an SQS concern. SQS's per-message maxAttempts is
    // advisory only; the queue's redrive policy is the hard enforcement and
    // may deliver beyond our intended limit. Database queues (SQLite/Postgres)
    // handle retry limits correctly in their claim queries (jobAttempts < jobRetryLimit),
    // but we include this guard for defense-in-depth and consistent behavior.
    if (job.attempts > job.maxAttempts) {
      return yield* new RetryBudgetExceededError({
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        queue: SYSTEM_STEP_EXECUTION_QUEUE,
      })
    }

    const stepCompletionOps = yield* StepCompletionOperations
    const scheduledFlowOps = yield* ScheduledFlowOperations
    const calendarQueries = yield* BusinessCalendarQueries
    const systemStepExecutor = yield* SystemStepExecutor
    const sqlClient = yield* SqlClient.SqlClient

    // Idempotency check - if already completed, exit early
    const alreadyCompleted = yield* completedJobOps.isJobCompleted(
      SYSTEM_STEP_EXECUTION_QUEUE,
      job.jobId,
    )
    if (alreadyCompleted) {
      yield* Effect.log("Job already completed, skipping", {
        jobId: job.jobId,
        todoId,
        stepPath,
      })
      return
    }

    yield* Effect.log("Processing system-step-execution job", {
      jobId: job.jobId,
      todoId,
      stepPath,
    })

    // Get todo info with step information
    const inputs = yield* withReadSnapshot(
      sqlClient,
      Effect.gen(function* () {
        const todoInfo = yield* stepCompletionOps.queryTodoById(todoId)
        if (!todoInfo) return null

        yield* Effect.logInfo("System-step-execution job resolved execution", {
          jobId: job.jobId,
          todoId,
          stepPath,
          processExecutionId: todoInfo.processExecutionId,
        })

        const processState =
          yield* stepCompletionOps.getProcessStateByTodoId(todoId)
        if (!processState) {
          return yield* new ProcessStateNotFoundError({
            processExecutionId: todoInfo.processExecutionId,
          })
        }
        const completedSteps =
          yield* stepCompletionOps.getCompletedStepsForExecution(
            todoInfo.processExecutionId,
          )
        return { todoInfo, processState, completedSteps }
      }),
    )
    if (!inputs) {
      // Todo doesn't exist - flow-execution may have rolled back
      // Mark as completed so we don't keep retrying
      yield* Effect.logWarning(
        "Todo not found - flow-execution may have rolled back",
        { todoId },
      )
      yield* completedJobOps.markJobCompleted(
        SYSTEM_STEP_EXECUTION_QUEUE,
        job.jobId,
      )
      return
    }

    const { todoInfo, processState, completedSteps } = inputs
    // Failure and replacement write identity are committed together. A late
    // delivery can have passed the completed-job check before that commit;
    // it must not activate the replacement identity until explicit restart
    // clears the failure. Read both from the same snapshot above.
    if (todoInfo.failureReason != null) {
      yield* Effect.log("Skipping delivery for a failed system-step Todo", {
        todoId,
        stepPath,
      })
      yield* completedJobOps.markJobCompleted(
        SYSTEM_STEP_EXECUTION_QUEUE,
        job.jobId,
      )
      return
    }
    const initiatingAudit = todoInfo.createdBy
    const scopedUserDetails =
      initiatingAudit !== undefined &&
      Option.isSome(decodeDelegationAudit(initiatingAudit))
        ? { by: initiatingAudit, id: null }
        : yield* UserDetails
    return yield* Effect.gen(function* () {
      // Build FlowContext from completed steps
      const ctx = buildFlowContext(
        todoInfo.processExecutionId,
        processState.processStartedAt,
        completedSteps,
      )

      // Execute the system step
      // For forEach steps, pass item_data directly as input (bypass executeWithInput)
      const isForEach = todoInfo.hasForEach

      yield* Effect.logDebug("Executing system step", {
        stepPath,
        processExecutionId: todoInfo.processExecutionId,
        isForEach,
        hasItemData: todoInfo.itemData !== null,
      })

      const forEachInput =
        isForEach && todoInfo.itemData !== null ? todoInfo.itemData : undefined

      const exit = yield* Effect.exit(
        withConfiguredSystemStepTimeout(
          stepPath,
          systemStepExecutor.execute(
            stepPath,
            processState.state,
            ctx,
            todoId,
            forEachInput,
            completedSteps.map((step) => step.stepPath),
            todoInfo.externalWriteAttemptId ?? undefined,
          ),
        ),
      )

      if (Exit.isFailure(exit)) {
        const errorTag = extractOutermostErrorTag(exit.cause)
        const {
          displayFailureReason,
          fullFailureReason,
          innerErrorText,
          isTerminal: isNonRetryable,
        } = formatExecutionFailure(exit.cause)

        const failureReason =
          displayFailureReason.length > 500
            ? `${displayFailureReason.slice(0, 497)}...`
            : displayFailureReason

        const isTerminal = isNonRetryable || job.attempts >= job.maxAttempts
        const hasMatchingOnError =
          isTerminal &&
          hasMatchingOnErrorFlow(
            yield* flowExecutionOps.queryFlowsBySourceStepId(
              todoInfo.targetStepId,
            ),
            errorTag,
          )

        const logFailure =
          isTerminal && !hasMatchingOnError
            ? Effect.logError
            : Effect.logWarning
        yield* logFailure("System step execution failed", {
          stepPath,
          processExecutionId: todoInfo.processExecutionId,
          todoId,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
          isTerminal,
          errorTag,
          failureReason: displayFailureReason,
          fullFailureReason,
          innerError: innerErrorText,
        })

        if (isTerminal) {
          // Record failure, either schedule onError flow evaluation or close the
          // execution, and mark the job completed in one transaction so routing
          // and the Failed status stay atomic with the Todo evidence.
          const outcome = yield* sqlClient.withTransaction(
            Effect.gen(function* () {
              if (!(yield* isJobAttemptCurrent))
                return { recorded: false as const }
              const failure = authorFacingFailure(exit.cause)
              const rejectedWrite =
                isNonRetryableAuthorError(failure) &&
                typeof failure === "object" &&
                failure !== null &&
                "externalWriteRejected" in failure &&
                failure.externalWriteRejected === true
              const recorded = yield* stepCompletionOps.failSystemStepAttempt({
                todoId,
                expectedWriteAttemptId: todoInfo.externalWriteAttemptId ?? null,
                expectedRestartAttemptId: todoInfo.restartAttemptId ?? null,
                failureReason,
                ...(rejectedWrite ? { nextWriteAttemptId: randomUUID() } : {}),
              })
              // Fence every terminal outcome, including a timeout from an old
              // delivery that finishes after rejection recovery has restarted.
              if (!recorded) {
                yield* completedJobOps.markJobCompleted(
                  SYSTEM_STEP_EXECUTION_QUEUE,
                  job.jobId,
                )
                return { recorded: false as const }
              }

              if (hasMatchingOnError) {
                const scheduledFlowId =
                  yield* scheduledFlowOps.insertScheduledFlow(
                    todoInfo.processExecutionId,
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
                    processExecutionId: todoInfo.processExecutionId,
                    scheduledFlowId,
                    onError: true,
                    ...(errorTag !== undefined && { errorTag }),
                    flowExecutionOps,
                  })
                }

                yield* completedJobOps.markJobCompleted(
                  SYSTEM_STEP_EXECUTION_QUEUE,
                  job.jobId,
                )

                return { recorded: true as const, scheduledFlowId }
              }

              yield* flowExecutionOps.setProcessExecutionFailed(
                todoInfo.processExecutionId,
                failureReason,
              )

              yield* completedJobOps.markJobCompleted(
                SYSTEM_STEP_EXECUTION_QUEUE,
                job.jobId,
              )

              return { recorded: true as const, scheduledFlowId: null }
            }),
          )

          if (!outcome.recorded) return
          if (!outcome.scheduledFlowId) {
            yield* recordDeploymentAudit(todoInfo.processExecutionId, {
              subtype: "failed",
            })
          }
          if (!queueService.queueInTransaction && outcome.scheduledFlowId) {
            yield* drainSystemStepFlowDispatch({
              dispatchId,
              queueService,
              flowExecutionOps,
            })
          }

          // Publish AFTER commit so clients see the failure.
          yield* queueService.enqueue(TODO_EVENT_QUEUE, {
            todoIds: [todoId],
          })
          const processId = yield* flowExecutionOps.getProcessIdForExecution(
            todoInfo.processExecutionId,
          )
          if (processId) {
            yield* queueService.enqueue(PROCESS_EVENT_QUEUE, { processId })
          }
          yield* queueService.enqueue(EXECUTION_EVENT_QUEUE, {
            executionId: todoInfo.processExecutionId,
          })
          yield* enqueueExecutionFailureNotificationJobs({
            processExecutionId: todoInfo.processExecutionId,
            stepPath,
            failureReason,
          })

          return
        }

        // Retries remaining: re-raise the original cause.
        return yield* Effect.failCause(exit.cause)
      }

      const result = exit.value

      // Deferred steps handle their own completion (e.g. Fargate task will do it).
      // If the deferred result includes a stateUpdate, merge it into process state
      // immediately so tracking metadata is persisted before the todo completes.
      // Both operations are wrapped in a transaction for atomicity — if either
      // fails, neither commits, and the job retries cleanly.
      if (result._tag === "Deferred") {
        yield* sqlClient.withTransaction(
          Effect.gen(function* () {
            if (!(yield* isJobAttemptCurrent)) return
            if (
              result.stateUpdate &&
              Object.keys(result.stateUpdate).length > 0
            ) {
              yield* stepCompletionOps.updateProcessState(
                todoInfo.processStateId,
                result.stateUpdate,
              )
            }
            yield* completedJobOps.markJobCompleted(
              SYSTEM_STEP_EXECUTION_QUEUE,
              job.jobId,
            )
          }),
        )
        yield* Effect.log("System step deferred to external executor", {
          stepPath,
          todoId,
        })
        return
      }

      const output = result.output

      yield* Effect.logInfo(
        "System step execution returned; completion pending",
        {
          jobId: job.jobId,
          todoId,
          processExecutionId: todoInfo.processExecutionId,
          stepPath,
          outputKeys: Object.keys(output),
        },
      )

      yield* completeSystemStep({
        todoId,
        stepPath,
        output,
        todoInfo,
        isForEach,
        jobId: job.jobId,
        queueService,
        completedJobOps,
        stepCompletionOps,
        scheduledFlowOps,
        flowExecutionOps,
        calendarQueries,
        sqlClient,
      })
    }).pipe(Effect.provideService(UserDetails, scopedUserDetails))
  })

const completeStartedSystemStep = (params: {
  jobId: string
  stepPath: string
  processExecutionId: string
  processStateId: string
  stepId: string
  output: Record<string, unknown>
  completedJobId: string
}) =>
  Effect.gen(function* () {
    const {
      processExecutionId,
      processStateId,
      stepId,
      output,
      completedJobId,
    } = params
    const queueService = yield* QueueService
    const completedJobOps = yield* CompletedJobOperations
    const stepCompletionOps = yield* StepCompletionOperations
    const scheduledFlowOps = yield* ScheduledFlowOperations
    const flowExecutionOps = yield* FlowExecutionOperations
    const sqlClient = yield* SqlClient.SqlClient
    const dispatchId = startedSystemStepDispatchId(processExecutionId)

    const scheduledFlowId = yield* sqlClient.withTransaction(
      Effect.gen(function* () {
        if (!(yield* isJobAttemptCurrent)) return undefined
        if (Object.keys(output).length > 0) {
          yield* stepCompletionOps.updateProcessState(processStateId, output)
        }

        const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
          processExecutionId,
          stepId,
        )

        if (queueService.queueInTransaction) {
          yield* queueService.enqueue(FLOW_EXECUTION_QUEUE, { scheduledFlowId })
          yield* Effect.log(
            "Staged flow after start system step completion (provisional until outer commit)",
            {
              scheduledFlowId,
            },
          )
        } else {
          yield* persistSystemStepFlowDispatch({
            dispatchId,
            processExecutionId,
            scheduledFlowId,
            flowExecutionOps,
          })
        }

        yield* completedJobOps.markJobCompleted(
          SYSTEM_STEP_EXECUTION_QUEUE,
          completedJobId,
        )

        return scheduledFlowId
      }),
    )

    if (scheduledFlowId === undefined) return
    yield* reportSystemStepCompletion(
      sqlClient,
      "Start system step completion committed",
      {
        jobId: params.jobId,
        stepPath: params.stepPath,
        processExecutionId,
        completedJobId,
        scheduledFlowId,
      },
    )
    yield* recordSuccessfulStepCompletion("automated")

    if (!queueService.queueInTransaction) {
      yield* drainSystemStepFlowDispatch({
        dispatchId,
        queueService,
        flowExecutionOps,
      })
      yield* Effect.log("Flow scheduled after start system step completion", {
        scheduledFlowId,
      })
    }

    const processId =
      yield* flowExecutionOps.getProcessIdForExecution(processExecutionId)
    if (processId) {
      yield* queueService.enqueue(PROCESS_EVENT_QUEUE, { processId })
    }
    yield* queueService.enqueue(EXECUTION_EVENT_QUEUE, {
      executionId: processExecutionId,
    })
  })

const handleStartedSystemStepExecution = (
  job: Job<StartSystemStepExecutionPayload>,
) =>
  Effect.gen(function* () {
    const { processExecutionId, stepId, stepPath } = job.payload
    const completedJobId =
      getStartedSystemStepCompletedJobId(processExecutionId)
    const queueService = yield* QueueService
    const flowExecutionOps = yield* FlowExecutionOperations

    if (
      !queueService.queueInTransaction &&
      (yield* drainSystemStepFlowDispatch({
        dispatchId: startedSystemStepDispatchId(processExecutionId),
        queueService,
        flowExecutionOps,
      }))
    ) {
      return
    }

    if (job.attempts > job.maxAttempts) {
      return yield* new RetryBudgetExceededError({
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        queue: SYSTEM_STEP_EXECUTION_QUEUE,
      })
    }

    const completedJobOps = yield* CompletedJobOperations
    const stepCompletionOps = yield* StepCompletionOperations
    const systemStepExecutor = yield* SystemStepExecutor

    const alreadyCompleted = yield* completedJobOps.isJobCompleted(
      SYSTEM_STEP_EXECUTION_QUEUE,
      completedJobId,
    )
    if (alreadyCompleted) {
      yield* Effect.log("Job already completed, skipping", {
        jobId: job.jobId,
        processExecutionId,
        stepPath,
      })
      return
    }

    yield* Effect.log("Processing start system-step-execution job", {
      jobId: job.jobId,
      processExecutionId,
      stepId,
      stepPath,
    })

    const sqlClient = yield* SqlClient.SqlClient
    const { processStateRaw, executionDetails, completedSteps } =
      yield* withReadSnapshot(
        sqlClient,
        Effect.gen(function* () {
          const processStateRaw =
            yield* flowExecutionOps.getProcessStateByExecutionId(
              processExecutionId,
            )
          if (!processStateRaw) {
            return yield* new ProcessStateNotFoundError({ processExecutionId })
          }
          const executionDetails =
            yield* flowExecutionOps.getExecutionDetailsForCompletion(
              processExecutionId,
            )
          if (!executionDetails) {
            return yield* new ProcessExecutionNotFoundError({
              processExecutionId,
            })
          }
          const completedSteps =
            yield* stepCompletionOps.getCompletedStepsForExecution(
              processExecutionId,
            )
          return { processStateRaw, executionDetails, completedSteps }
        }),
      )

    const initiatingAudit = processStateRaw.createdBy
    const scopedUserDetails =
      initiatingAudit !== undefined &&
      Option.isSome(decodeDelegationAudit(initiatingAudit))
        ? { by: initiatingAudit, id: null }
        : yield* UserDetails
    return yield* Effect.gen(function* () {
      const processState = yield* Schema.decodeUnknownEffect(
        ProcessStateSchema,
      )(processStateRaw.state ?? {}).pipe(
        Effect.mapError(
          () =>
            new InvalidProcessStateError({
              processExecutionId,
              reason: "State is not a valid record",
            }),
        ),
      )

      const ctx = buildFlowContext(
        processExecutionId,
        DateTime.makeUnsafe(executionDetails.createdAtMs),
        completedSteps,
      )

      const exit = yield* Effect.exit(
        withConfiguredSystemStepTimeout(
          stepPath,
          systemStepExecutor.execute(
            stepPath,
            processState,
            ctx,
            completedJobId,
            undefined,
            completedSteps.map((step) => step.stepPath),
          ),
        ),
      )

      if (Exit.isFailure(exit)) {
        const errorTag = extractOutermostErrorTag(exit.cause)
        const {
          displayFailureReason,
          fullFailureReason,
          innerErrorText,
          isTerminal: isNonRetryable,
        } = formatExecutionFailure(exit.cause)
        const isTerminal = isNonRetryable || job.attempts >= job.maxAttempts

        const logFailure = isTerminal ? Effect.logError : Effect.logWarning
        yield* logFailure("Start system step execution failed", {
          processExecutionId,
          stepPath,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
          isTerminal,
          errorTag,
          failureReason: displayFailureReason,
          fullFailureReason,
          innerError: innerErrorText,
        })

        if (isTerminal) {
          yield* recordStartedSystemStepFailure(job, displayFailureReason)
          return
        }

        return yield* Effect.failCause(exit.cause)
      }

      const result = exit.value
      if (result._tag === "Deferred") {
        yield* Effect.log("Start system step deferred to external executor", {
          processExecutionId,
          stepPath,
        })
        yield* completedJobOps.markJobCompleted(
          SYSTEM_STEP_EXECUTION_QUEUE,
          completedJobId,
        )
        return
      }

      const output = result.output
      yield* Effect.logInfo(
        "Start system step execution returned; completion pending",
        {
          jobId: job.jobId,
          processExecutionId,
          stepPath,
          outputKeys: Object.keys(output),
        },
      )

      yield* completeStartedSystemStep({
        jobId: job.jobId,
        stepPath,
        processExecutionId,
        processStateId: processStateRaw.processStateId,
        stepId,
        output,
        completedJobId,
      })
    }).pipe(Effect.provideService(UserDetails, scopedUserDetails))
  })

/**
 * Inner handler for system-step-execution. Extracted so the outer handler
 * can wrap it with last-attempt failure recording.
 */
const handleSystemStepExecutionInner = (
  job: Job<SystemStepExecutionPayload>,
) =>
  isTodoPayload(job.payload)
    ? handleTodoSystemStepExecution(job as Job<SystemStepTodoPayload>)
    : handleStartedSystemStepExecution(
        job as Job<StartSystemStepExecutionPayload>,
      )

export const executeSystemStep = (job: Job<SystemStepExecutionPayload>) =>
  withUserDetailsScope(handleSystemStepExecution(job))
