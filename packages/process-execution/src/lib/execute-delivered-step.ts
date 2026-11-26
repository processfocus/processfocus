import { Effect, type Schema } from "effect"
import { StepCompletionOperations } from "@pf/graphql-db-operations"
import {
  NotASystemStepError,
  OrganisationProvider,
  type StepMeta,
  StepNotFoundError,
  type SystemStep,
  buildFlowContext,
} from "@pf/process"
import { ProcessStateNotFoundError } from "../errors"
import { completeDeliveredSystemStep } from "./async-system-step"
import { recoverTodoSystemStepFlowDispatch } from "./system-step-flow-dispatch"

/** Run the action in its already-launched executor, rather than relaunching it. */
export const executeDeliveredSystemStep = (command: {
  readonly todoId: string
  readonly jobId: string
}) =>
  Effect.gen(function* () {
    if (yield* recoverTodoSystemStepFlowDispatch(command.todoId)) return
    const operations = yield* StepCompletionOperations
    const todo = yield* operations.queryTodoById(command.todoId)
    if (!todo) return
    const state = yield* operations.getProcessStateByTodoId(command.todoId)
    const { organisation } = yield* OrganisationProvider
    const step = organisation.stepByPath(todo.targetStepPath)
    if (!state)
      return yield* new ProcessStateNotFoundError({
        processExecutionId: todo.processExecutionId,
      })
    if (!step)
      return yield* new StepNotFoundError({ stepPath: todo.targetStepPath })
    if (!step.isSystemStep)
      return yield* new NotASystemStepError({ stepPath: todo.targetStepPath })
    // Authored definitions cross bundle boundaries; the stable brand validates
    // the runtime shape before erasing their compile-time state/input types.
    const systemStep = step as unknown as SystemStep<
      Record<string, unknown>,
      Record<string, StepMeta>,
      unknown,
      Schema.Struct.Fields,
      string
    >
    const completedSteps = yield* operations.getCompletedStepsForExecution(
      todo.processExecutionId,
    )
    const context = buildFlowContext(
      todo.processExecutionId,
      state.processStartedAt,
      completedSteps,
    )
    const input =
      todo.hasForEach && todo.itemData !== null
        ? todo.itemData
        : yield* systemStep.input(state.state, context)
    // This authored external action is outside completion's database transaction.
    const output = yield* systemStep.execute(input)
    yield* completeDeliveredSystemStep({ ...command, output })
  })
