import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import {
  CompletedJobOperations,
  FlowExecutionOperations,
  SYSTEM_STEP_EXECUTION_QUEUE,
  StepCompletionOperations,
  getStartedSystemStepCompletedJobId,
} from "@pf/graphql-db-operations"

export const SystemStepRecoveryTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("todo"),
    id: Schema.String,
    restartAttemptId: Schema.NullOr(Schema.String),
    writeAttemptId: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("execution"),
    id: Schema.String,
    restartAttemptId: Schema.NullOr(Schema.String),
  }),
])
export type SystemStepRecoveryTarget = typeof SystemStepRecoveryTarget.Type

/** Read closed work too: accepting a redrive must not adopt a later restart. */
const readTarget = (reference: Pick<SystemStepRecoveryTarget, "kind" | "id">) =>
  Effect.gen(function* () {
    const flows = yield* FlowExecutionOperations
    if (reference.kind === "execution") {
      const execution = yield* flows.getExecutionDetailsForCompletion(
        reference.id,
      )
      return execution
        ? {
            target: {
              ...reference,
              kind: "execution" as const,
              restartAttemptId: execution.restartAttemptId,
            },
            executionId: reference.id,
            open: yield* flows.isProcessExecutionOpen(reference.id),
          }
        : undefined
    }
    const steps = yield* StepCompletionOperations
    const todo = yield* steps.queryTodoForCompletionById(reference.id)
    return todo
      ? {
          target: {
            kind: "todo" as const,
            id: todo.id,
            restartAttemptId: todo.restartAttemptId ?? null,
            writeAttemptId: todo.externalWriteAttemptId ?? null,
          },
          executionId: todo.processExecutionId,
          open: !todo.completed && todo.failureReason == null,
        }
      : undefined
  })

export const captureSystemStepTarget = (job: {
  readonly queue: string
  readonly payload: unknown
}) =>
  Effect.gen(function* () {
    if (
      job.queue !== SYSTEM_STEP_EXECUTION_QUEUE ||
      typeof job.payload !== "object" ||
      job.payload === null
    )
      return undefined
    const reference =
      "processExecutionId" in job.payload &&
      typeof job.payload.processExecutionId === "string"
        ? { kind: "execution" as const, id: job.payload.processExecutionId }
        : "todoId" in job.payload && typeof job.payload.todoId === "string"
          ? { kind: "todo" as const, id: job.payload.todoId }
          : undefined
    return reference ? (yield* readTarget(reference))?.target : undefined
  })

const isCurrent = (
  expected: SystemStepRecoveryTarget,
  current: SystemStepRecoveryTarget,
): boolean =>
  expected.restartAttemptId === current.restartAttemptId &&
  (expected.kind !== "todo" ||
    (current.kind === "todo" &&
      expected.writeAttemptId === current.writeAttemptId))

/** Completion/outbox rules belong to the handler, not the queue's claim state. */
export const checkSystemStepAttempt = (input: {
  readonly job: { readonly queue: string; readonly jobId: string }
  readonly target: SystemStepRecoveryTarget
  readonly purpose: "mutate" | "dispatch"
}) =>
  Effect.gen(function* () {
    const current = yield* readTarget(input.target)
    if (
      !current ||
      current.target.restartAttemptId !== input.target.restartAttemptId
    )
      return false
    if (current.open && isCurrent(input.target, current.target)) return true
    if (input.purpose === "mutate") return false
    // A completion committed before an SQS send failure must still drain its
    // outbox. This permission never crosses an explicit restart.
    const completed = yield* CompletedJobOperations
    return yield* completed.isJobCompleted(
      input.job.queue,
      input.target.kind === "execution"
        ? getStartedSystemStepCompletedJobId(input.target.id)
        : input.job.jobId,
    )
  })

/** Atomically check the generation and fail its open work. A delivery adapter's
 * enclosing transaction may additionally commit terminal delivery evidence.
 * This is an operational failure, NOT a known rejected external effect: retain
 * the write identity and never guess an authored error tag/onError branch.
 */
export const recoverUnknownSystemStep = (command: {
  readonly target: SystemStepRecoveryTarget
  readonly reason: string
}) =>
  Effect.gen(function* () {
    const { target, reason } = command
    const sqlClient = yield* SqlClient.SqlClient
    return yield* sqlClient.withTransaction(
      Effect.gen(function* () {
        const steps = yield* StepCompletionOperations
        const flows = yield* FlowExecutionOperations
        const current = yield* readTarget(target)
        if (
          !current?.open ||
          !isCurrent(target, current.target) ||
          !(yield* flows.isProcessExecutionOpen(current.executionId))
        )
          return
        if (target.kind === "todo") {
          if (
            !(yield* steps.failSystemStepAttempt({
              todoId: target.id,
              expectedRestartAttemptId: target.restartAttemptId,
              expectedWriteAttemptId: target.writeAttemptId,
              failureReason: reason,
            }))
          )
            return
        }
        yield* flows.setProcessExecutionFailed(current.executionId, reason)
      }),
    )
  })
