import { QueueService } from "@processfocus/runtime"
import { Effect, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import {
  BusinessCalendarQueries,
  CompletedJobOperations,
  FlowExecutionOperations,
  ScheduledFlowOperations,
  StepCompletionOperations,
  UserDetails,
  decodeDelegationAudit,
} from "@pf/graphql-db-operations"
import {
  NotASystemStepError,
  OrganisationProvider,
  OutputValidationError,
  StepNotFoundError,
} from "@pf/process"
import { ProcessStateNotFoundError } from "../errors"
import {
  completeAsyncSystemStep as complete,
  completeSystemStep as completeDelivered,
  failAsyncSystemStep as fail,
  failTerminalSystemStep as failTerminal,
} from "./complete-system-step"
import { recoverTodoSystemStepFlowDispatch } from "./system-step-flow-dispatch"

const collaborators = Effect.gen(function* () {
  return {
    queueService: yield* QueueService,
    stepCompletionOps: yield* StepCompletionOperations,
    scheduledFlowOps: yield* ScheduledFlowOperations,
    flowExecutionOps: yield* FlowExecutionOperations,
    sqlClient: yield* SqlClient.SqlClient,
  }
})

/** Complete a platform-delivered action using current persisted execution facts. */
export const completeDeliveredSystemStep = (command: {
  readonly todoId: string
  readonly output: unknown
  readonly jobId: string
}) =>
  Effect.gen(function* () {
    if (yield* recoverTodoSystemStepFlowDispatch(command.todoId)) return
    const services = yield* collaborators
    const todo = yield* services.stepCompletionOps.queryTodoById(command.todoId)
    if (!todo) return
    const { organisation } = yield* OrganisationProvider
    const step = organisation.stepByPath(todo.targetStepPath)
    if (!step)
      return yield* new StepNotFoundError({ stepPath: todo.targetStepPath })
    if (!step.isSystemStep)
      return yield* new NotASystemStepError({ stepPath: todo.targetStepPath })
    const state = yield* services.stepCompletionOps.getProcessStateByTodoId(
      command.todoId,
    )
    if (!state)
      return yield* new ProcessStateNotFoundError({
        processExecutionId: todo.processExecutionId,
      })
    // The stable system-step brand is valid across organisation bundle boundaries.
    const { output: fields } = step as unknown as {
      output: Schema.Struct.Fields
    }
    const output =
      Object.keys(fields).length === 0
        ? {}
        : yield* Schema.decodeUnknownEffect(Schema.Struct(fields))(
            command.output,
          ).pipe(
            Effect.mapError(
              (error) =>
                new OutputValidationError({
                  stepPath: todo.targetStepPath,
                  error,
                }),
            ),
          )
    const identity =
      todo.createdBy && Option.isSome(decodeDelegationAudit(todo.createdBy))
        ? { by: todo.createdBy, id: null }
        : yield* UserDetails
    return yield* completeDelivered({
      ...services,
      ...command,
      output,
      completedJobOps: yield* CompletedJobOperations,
      calendarQueries: yield* BusinessCalendarQueries,
      stepPath: todo.targetStepPath,
      todoInfo: todo,
      isForEach: todo.hasForEach,
    }).pipe(Effect.provideService(UserDetails, identity))
  })

export const completeAsyncSystemStep = (command: {
  readonly todoId: string
  readonly output: Record<string, unknown>
}) =>
  Effect.gen(function* () {
    if (yield* recoverTodoSystemStepFlowDispatch(command.todoId)) return true
    const services = yield* collaborators
    const calendarQueries = yield* BusinessCalendarQueries
    const todo = yield* services.stepCompletionOps.queryTodoById(command.todoId)
    if (!todo) return false
    const identity =
      todo.createdBy && Option.isSome(decodeDelegationAudit(todo.createdBy))
        ? { by: todo.createdBy, id: null }
        : yield* UserDetails
    return yield* complete({
      ...services,
      calendarQueries,
      todoId: todo.id,
      stepPath: todo.targetStepPath,
      output: command.output,
      todoInfo: todo,
      isForEach: todo.hasForEach,
    }).pipe(Effect.provideService(UserDetails, identity))
  })

interface FailureCommand {
  readonly todoId: string
  readonly failureReason: string
  readonly errorTag?: string
}

export const failAsyncSystemStep = (command: FailureCommand) =>
  Effect.gen(function* () {
    const services = yield* collaborators
    const todo = yield* services.stepCompletionOps.queryTodoById(command.todoId)
    if (!todo) return { didFail: false } as const
    const identity =
      todo.createdBy && Option.isSome(decodeDelegationAudit(todo.createdBy))
        ? { by: todo.createdBy, id: null }
        : yield* UserDetails
    return yield* fail({
      ...services,
      ...command,
      processExecutionId: todo.processExecutionId,
    }).pipe(Effect.provideService(UserDetails, identity))
  })

export const failTerminalSystemStep = (
  command: FailureCommand & {
    readonly completedJob?: {
      readonly namespace: string
      readonly jobId: string
    }
  },
) =>
  Effect.gen(function* () {
    const services = yield* collaborators
    const todo = yield* services.stepCompletionOps.queryTodoById(command.todoId)
    if (!todo) return { didFail: false } as const
    const completedJob = command.completedJob
      ? { ...command.completedJob, ops: yield* CompletedJobOperations }
      : undefined
    return yield* failTerminal({
      ...services,
      todoId: command.todoId,
      failureReason: command.failureReason,
      ...(command.errorTag === undefined ? {} : { errorTag: command.errorTag }),
      ...(completedJob === undefined ? {} : { completedJob }),
      processExecutionId: todo.processExecutionId,
    })
  })
