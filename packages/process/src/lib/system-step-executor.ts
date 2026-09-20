import { Context, Data, Effect, Option, Schema } from "effect"
import type { FlowContext, StepMeta } from "./flow-context"
import type { Organisation } from "./organisation"
import {
  type AuthorTaggedError,
  CurrentStepJobContext,
  type ForEachStepRequiresItemsError,
  type StepResult,
  type SystemStep,
} from "./system-step"

/**
 * Error thrown when the target step cannot be found in the organisation.
 */
export class StepNotFoundError extends Data.TaggedError("StepNotFoundError")<{
  readonly stepPath: string
}> {}

/**
 * Error thrown when the step is not a SystemStep.
 */
export class NotASystemStepError extends Data.TaggedError(
  "NotASystemStepError",
)<{
  readonly stepPath: string
}> {}

/**
 * Reserved tag for system-step execution envelopes.
 *
 * The executor no longer wraps failures in this type: author execute/input
 * Effects should fail with AuthorTaggedError, which passes through for onError
 * routing. The class remains exported so job-handler formatting can treat
 * `SystemStepExecutionError` as a reserved/internal tag if it appears in a
 * cause (e.g. older payloads or external call sites).
 */
export class SystemStepExecutionError extends Data.TaggedError(
  "SystemStepExecutionError",
)<{
  readonly stepPath: string
  readonly error: unknown
  readonly message: string
}> {}

/**
 * Error thrown when the output validation fails.
 */
export class OutputValidationError extends Data.TaggedError(
  "OutputValidationError",
)<{
  readonly stepPath: string
  readonly error: unknown
}> {}

/**
 * Error thrown when dispatching a long-duration step fails.
 */
export class LongDurationDispatchError extends Data.TaggedError(
  "LongDurationDispatchError",
)<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * All possible errors from system step execution.
 *
 * Author domain errors (AuthorTaggedError) pass through as-is so onError
 * routing can match their `_tag` without unwrapping an envelope.
 * `SystemStepExecutionError` is not produced by the executor; it remains a
 * separate exported class for reserved-tag formatting if it appears in a cause.
 */
export type SystemStepExecutorError =
  | StepNotFoundError
  | NotASystemStepError
  | OutputValidationError
  | LongDurationDispatchError
  | ForEachStepRequiresItemsError
  | AuthorTaggedError

/**
 * Optional service used to dispatch long-duration system steps out-of-process.
 */
export class LongDurationDispatcher extends Context.Tag(
  "@pf/process/LongDurationDispatcher",
)<
  LongDurationDispatcher,
  {
    readonly dispatch: (
      todoId: string,
      stepPath: string,
    ) => Effect.Effect<void, LongDurationDispatchError>
  }
>() {}

/**
 * Optional service that lets system steps read their process state at
 * execution time. Used by deferred steps to check idempotency guards
 * (e.g. has this Resend email already been sent on a previous retry?).
 */
export class StepProcessStateReader extends Context.Tag(
  "@pf/process/StepProcessStateReader",
)<
  StepProcessStateReader,
  {
    /**
     * Read the current process state for a given todo.
     * Returns the full state object (may be empty).
     */
    readonly getProcessStateByTodoId: (
      todoId: string,
    ) => Effect.Effect<Record<string, unknown>>
  }
>() {}

/**
 * Service interface for executing system steps.
 *
 * The execute function may return an Effect with requirements (services needed
 * by the system step's execute function). These requirements must be provided
 * by the caller.
 */
export interface SystemStepExecutorService {
  /**
   * Execute a system step against the current process state.
   *
   * @param stepPath - Path of the system step to execute
   * @param state - Current process state
   * @param ctx - Flow context with completed step metadata
   * @param todoId - The todo ID for the current job (passed to executeStep for dispatch)
   * @param forEachInput - Optional pre-computed input for forEach steps (bypasses input derivation)
   * @param completedStepPaths - Completed steps whose JSON state values can be schema-rehydrated
   * @returns A StepResult: Completed with output, or Deferred for async dispatch.
   */
  readonly execute: (
    stepPath: string,
    state: Record<string, unknown>,
    ctx: FlowContext<Record<string, StepMeta>>,
    todoId: string,
    forEachInput?: unknown,
    completedStepPaths?: readonly string[],
  ) => Effect.Effect<StepResult, SystemStepExecutorError, unknown>
}

const rehydrateCompletedStepState = (
  org: Organisation,
  state: Record<string, unknown>,
  completedStepPaths: readonly string[],
) =>
  Effect.gen(function* () {
    const rehydrated = { ...state }
    const skipRehydration = Symbol("skipRehydration")

    for (const stepPath of completedStepPaths) {
      const step = org.stepByPath(stepPath)
      if (!step || step.hasForEach) continue

      const output = step.output
      if (!output) continue

      for (const [key, schema] of Object.entries(output)) {
        if (!(key in rehydrated)) continue
        if (!Schema.isSchema(schema)) {
          continue
        }

        const decoded = yield* Schema.decodeUnknown(schema)(
          rehydrated[key],
        ).pipe(
          // Some fields are already decoded, dynamic, or structural-only. Keep
          // the persisted value unless this field schema can rehydrate it.
          Effect.catchAll((error) =>
            Effect.logDebug("Skipped process state field rehydration", {
              stepPath,
              field: key,
              error,
            }).pipe(Effect.as(skipRehydration)),
          ),
        )

        if (decoded !== skipRehydration) {
          rehydrated[key] = decoded
        }
      }
    }

    return rehydrated
  })

/**
 * Context tag for the SystemStepExecutor service.
 */
export class SystemStepExecutor extends Context.Tag(
  "@pf/process/SystemStepExecutor",
)<SystemStepExecutor, SystemStepExecutorService>() {}

/**
 * Create a SystemStepExecutor service from an Organisation.
 *
 * @param org - The organisation containing process definitions
 * @returns A SystemStepExecutorService implementation
 */
export const makeSystemStepExecutor = (
  org: Organisation,
): SystemStepExecutorService => ({
  execute: (
    stepPath,
    state,
    ctx,
    todoId,
    forEachInput?,
    completedStepPaths?,
  ) => {
    const effect = Effect.gen(function* () {
      // Find the step by path (handles paths with or without leading slash)
      const step = org.stepByPath(stepPath)
      if (!step) {
        return yield* new StepNotFoundError({ stepPath })
      }

      // Verify this is a SystemStep (check property, not instanceof, for cross-bundle compatibility)
      if (!step.isSystemStep) {
        return yield* new NotASystemStepError({ stepPath })
      }

      // Now step is narrowed to SystemStep
      // Use unknown intermediate type to satisfy TypeScript
      // biome-ignore lint/suspicious/noExplicitAny: Type erasure at runtime, values are compatible
      const systemStep = step as any as SystemStep<
        Record<string, unknown>,
        Record<string, StepMeta>,
        unknown,
        Schema.Struct.Fields,
        string
      >

      const jobContext = { todoId, stepPath }
      const rehydrationStepPaths = [
        ...(completedStepPaths ?? []),
        // Start-step completions may not have a todo, so include all forms from
        // this process and only decode fields present in the persisted state.
        ...systemStep.process.forms().map(({ path }) => path),
      ]
      const processState = yield* rehydrateCompletedStepState(org, state, [
        ...new Set(rehydrationStepPaths),
      ])

      // Derive input then delegate to executeStep():
      // - forEach steps: use pre-computed item data as input
      // - Regular steps: derive input from state
      // AuthorTaggedError / ForEachStepRequiresItemsError flow through typed.
      const input =
        forEachInput !== undefined
          ? forEachInput
          : yield* systemStep.input(processState, ctx)

      // Long-duration steps can be dispatched to an external worker when available.
      // If no dispatcher service is provided (e.g. local runtime), run inline.
      if (systemStep.longDuration) {
        const dispatcherOption = yield* Effect.serviceOption(
          LongDurationDispatcher,
        )
        if (Option.isSome(dispatcherOption)) {
          yield* dispatcherOption.value.dispatch(todoId, stepPath)
          return { _tag: "Deferred" as const }
        }
      }

      // Run the step. Long-duration steps that were dispatched returned
      // Deferred above. Tagged author errors pass through for onError routing.
      const result = yield* systemStep
        .executeStep(input, jobContext)
        .pipe(Effect.provideService(CurrentStepJobContext, jobContext))

      // Deferred steps handle their own completion — return as-is
      if (result._tag === "Deferred") {
        return result
      }

      // Validate output for Completed results
      const rawOutput = result.output
      const outputFields = systemStep.output
      if (Object.keys(outputFields).length === 0) {
        return {
          _tag: "Completed" as const,
          output: {} as Record<string, unknown>,
        }
      }

      // Create a schema from the output fields and validate
      const outputSchema = Schema.Struct(outputFields)
      const validatedOutput = yield* Schema.decodeUnknown(outputSchema)(
        rawOutput,
      ).pipe(
        Effect.mapError(
          (error) => new OutputValidationError({ stepPath, error }),
        ),
      )

      return {
        _tag: "Completed" as const,
        output: validatedOutput as Record<string, unknown>,
      }
    })

    // Return effect with propagated requirements from the step's execute function
    return effect
  },
})
