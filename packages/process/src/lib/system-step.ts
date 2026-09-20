import type { Schema } from "effect"
import { Context, Data, Effect } from "effect"
import type {
  FlowContext,
  ForEachOutput,
  FormStepMeta,
  MergeFormStep,
  MergeSteps,
  StepMeta,
} from "./flow-context"
import {
  type FlowPath,
  type MergeState,
  type OnErrorOptions,
  createOnErrorFlowPath,
} from "./flow-path"
import type { Phase } from "./phase"
import type { InferSchemaType, Process, ResolveStepOutput } from "./process"
import type { SlaConfig } from "./sla"
import { type IStepScope, Step, type StepProps } from "./step"

/**
 * Domain failures from author-defined process callbacks.
 * Must be tagged so onError routing can match `_tag` without duck-typing.
 *
 * Set `retryable: false` for deterministic refusals (validation failures,
 * unsupported operations, configuration mismatches) so system-step-execution
 * records the todo failure immediately instead of re-raising for delayed
 * retries. Omit the field (or set `true`) for transient failures that may
 * succeed on a later attempt.
 */
export type AuthorTaggedError = {
  readonly _tag: string
  readonly retryable?: boolean
}

/**
 * Structural guard for AuthorTaggedError (cross-boundary safe; no instanceof).
 */
export const isAuthorTaggedError = (
  error: unknown,
): error is AuthorTaggedError =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  typeof (error as { _tag?: unknown })._tag === "string"

/**
 * True when a failure value explicitly opts out of system-step retries.
 * Cross-boundary safe: checks the `retryable` field without `instanceof`.
 */
export const isNonRetryableAuthorError = (error: unknown): boolean =>
  isAuthorTaggedError(error) && error.retryable === false

/**
 * Pass through a tagged author error, otherwise replace with `fallback`.
 * Use at org/plugin boundaries that still yield untyped Effect failure channels.
 */
export const coerceAuthorTaggedError = (
  error: unknown,
  fallback: AuthorTaggedError,
): AuthorTaggedError => (isAuthorTaggedError(error) ? error : fallback)

/**
 * Error when `input()` is called on a forEach step (use `forEachItems()` instead).
 */
export class ForEachStepRequiresItemsError extends Data.TaggedError(
  "ForEachStepRequiresItemsError",
)<{
  readonly stepPath: string
}> {}

/**
 * Error when `forEachItems()` is called on a step that does not use forEach.
 */
export class NotAForEachStepError extends Data.TaggedError(
  "NotAForEachStepError",
)<{
  readonly stepPath: string
}> {}

/**
 * Result of executeStep() — a tagged union controlling dispatch behavior.
 *
 * - `Completed`: step ran inline and produced output to merge into state.
 * - `Deferred`: step dispatched work externally (e.g. Fargate) and will
 *   complete itself asynchronously. The handler should mark the job done
 *   without completing the todo.
 *
 * When a `Deferred` result includes a `stateUpdate`, the handler merges it
 * into process state immediately (before the todo completes). Plugin-internal
 * metadata must be namespaced under `_internal.<plugin>` to avoid collisions
 * between plugins that adopt deferred delivery (e.g. `_internal.resend`).
 */
export type StepResult =
  | { readonly _tag: "Completed"; readonly output: Record<string, unknown> }
  | {
      readonly _tag: "Deferred"
      readonly stateUpdate?: Record<string, unknown>
    }

/**
 * Context passed to executeStep() so dispatch strategies can reference
 * the current job's identifiers.
 */
export interface StepJobContext {
  readonly todoId: string
  readonly stepPath: string
}

/**
 * Current system-step job identifiers, provided while `executeStep` runs.
 * Use this from NodeStep `execute` callbacks that need the Todo identity
 * for replay-safe side effects.
 */
export class CurrentStepJobContext extends Context.Tag(
  "@pf/process/CurrentStepJobContext",
)<CurrentStepJobContext, StepJobContext>() {}

/**
 * Configuration for forEach (multi-instance) steps.
 * When present, the step produces N todos from a dynamic list of items.
 *
 * @typeParam TState - Accumulated state from previous steps
 * @typeParam TSteps - Record of completed step metadata for ctx.step access
 * @typeParam TItem - Type of each item in the array
 */
export interface ForEachConfig<
  TState,
  TSteps extends Record<string, StepMeta | FormStepMeta>,
  TItem,
> {
  readonly items: (
    state: TState,
    ctx: FlowContext<TSteps>,
  ) => Effect.Effect<ReadonlyArray<TItem>, AuthorTaggedError, unknown>
}

/**
 * Base props shared by both input-based and forEach-based SystemSteps.
 */
interface SystemStepPropsBase<
  TOutput extends Schema.Struct.Fields = Schema.Struct.Fields,
> {
  readonly name?: string
  readonly purpose?: string
  readonly phase?: Phase
  readonly sla?: SlaConfig
  readonly alwaysNotify?: boolean
  readonly longDuration?: boolean
  readonly output: TOutput
  /**
   * Maximum number of retry attempts when the step fails.
   * - `0`: No retries - fail immediately on first error
   * - `1+`: Retry up to this many times after failure
   * - `undefined`: Use system default (typically 5)
   *
   * Only applies to system steps (role IS NULL). Form steps ignore this setting.
   */
  readonly retries?: number
}

/**
 * Props for SystemStep - a step executed by the system without human interaction.
 *
 * SystemSteps do not have a `role` property - they are executed by the system.
 * `input` and `forEach` are mutually exclusive: when `forEach` is present,
 * `items(state, ctx)` returns `Array<TInput>` directly — the items ARE the inputs.
 *
 * @typeParam TState - Accumulated state from previous steps
 * @typeParam TSteps - Record of completed step metadata for ctx.step access
 * @typeParam TInput - Input derived from state
 * @typeParam TOutput - Output schema fields merged into process state
 * @typeParam TIsForEach - Whether this step uses forEach semantics
 */
export type SystemStepProps<
  TState = Record<string, never>,
  TSteps extends Record<string, StepMeta | FormStepMeta> = Record<
    string,
    never
  >,
  TInput = unknown,
  TOutput extends Schema.Struct.Fields = Schema.Struct.Fields,
  TIsForEach extends boolean = false,
> = SystemStepPropsBase<TOutput> &
  (TIsForEach extends true
    ? {
        forEach: ForEachConfig<TState, TSteps, TInput>
        input?: never
      }
    : {
        input: (
          state: TState,
          ctx: FlowContext<TSteps>,
        ) => Effect.Effect<TInput, AuthorTaggedError, unknown>
        forEach?: never
      })

/**
 * Abstract base class for system-executed steps.
 *
 * SystemStep represents a step that is automatically executed by the job worker
 * when the flow reaches it, rather than waiting for human interaction.
 *
 * Unlike Form steps which have a `role` (who completes them), SystemSteps have
 * no role - they are executed by the system. In the database, this is represented
 * by `role_id = NULL`.
 *
 * Subclasses must implement the `execute` method which contains the business logic.
 *
 * @typeParam TState - Accumulated state from previous steps
 * @typeParam TSteps - Record of completed step metadata for ctx.step access
 * @typeParam TInput - Input derived from state
 * @typeParam TOutput - Output schema fields merged into process state
 * @typeParam TId - Step identifier literal type
 *
 * @example
 * ```typescript
 * // NodeStep is a concrete implementation that takes execute as a prop
 * const greet = new NodeStep(register, "Greet", {
 *   input: (state) => Effect.succeed({ name: state.name }),
 *   output: {},
 *   execute: (input) => Effect.gen(function* () {
 *     console.log(`Hello ${input.name}`)
 *   }),
 * })
 * ```
 */
export abstract class SystemStep<
  TState = Record<string, never>,
  TSteps extends Record<string, StepMeta | FormStepMeta> = Record<
    string,
    never
  >,
  TInput = unknown,
  TOutput extends Schema.Struct.Fields = Schema.Struct.Fields,
  TId extends string = string,
  TIsForEach extends boolean = false,
> extends Step<TState, TOutput, TId, false, TIsForEach> {
  override readonly isSystemStep = true
  readonly longDuration: boolean

  /**
   * Maximum number of retry attempts when the step fails.
   * - `0`: No retries - fail immediately on first error
   * - `1+`: Retry up to this many times after failure
   * - `undefined`: Use system default
   */
  readonly retries: number | undefined

  /**
   * The input derivation function, stored for runtime execution.
   * Undefined when forEach is used (items replaces input).
   */
  private _inputFn:
    | ((
        state: TState,
        ctx: FlowContext<TSteps>,
      ) => Effect.Effect<TInput, AuthorTaggedError, unknown>)
    | undefined

  /**
   * The forEach items function, stored for runtime execution.
   * Undefined when input is used instead.
   */
  private _forEachItemsFn:
    | ((
        state: TState,
        ctx: FlowContext<TSteps>,
      ) => Effect.Effect<ReadonlyArray<TInput>, AuthorTaggedError, unknown>)
    | undefined

  constructor(
    scope:
      | Process
      | IStepScope<TState, TSteps>
      | FlowPath<TState, Schema.Struct.Fields | undefined, TSteps>,
    id: TId,
    // biome-ignore lint/suspicious/noExplicitAny: Discriminated union requires relaxed typing in constructor
    props: SystemStepProps<TState, TSteps, TInput, TOutput, any>,
  ) {
    // Build step props without role (system steps have no role)
    const stepProps = {
      ...(props.name !== undefined && { name: props.name }),
      ...(props.purpose !== undefined && { purpose: props.purpose }),
      ...(props.phase !== undefined && { phase: props.phase }),
      ...(props.sla !== undefined && { sla: props.sla }),
      ...(props.alwaysNotify !== undefined && {
        alwaysNotify: props.alwaysNotify,
      }),
      // Output schema fields (what this step contributes to state)
      output: props.output,
    } as StepProps<TOutput>

    super(scope, id, stepProps)
    this.longDuration = props.longDuration ?? false
    // Validate retries: must be non-negative integer if provided
    if (props.retries !== undefined) {
      if (!Number.isInteger(props.retries) || props.retries < 0) {
        throw new Error(
          `Step "${id}" has invalid retries value: ${props.retries}. Must be a non-negative integer.`,
        )
      }
    }
    this.retries = props.retries
    if (props.forEach) {
      this._forEachItemsFn = props.forEach.items
      // Override brand property for cross-bundle detection
      ;(this as { hasForEach: boolean }).hasForEach = true
    } else {
      this._inputFn = props.input
    }
  }

  /**
   * Get the output schema for this step.
   * Overrides base to return non-undefined (SystemSteps always have output).
   */
  override get output(): TOutput {
    return super.output as TOutput
  }

  /**
   * Derive input from the current process state and context.
   * Called by SystemStepExecutor before executing.
   * Fails with ForEachStepRequiresItemsError if this is a forEach step
   * (use forEachItems instead). Author input callbacks may fail with
   * AuthorTaggedError; requirements stay deferred on R.
   */
  input(
    state: TState,
    ctx: FlowContext<TSteps>,
  ): Effect.Effect<
    TInput,
    ForEachStepRequiresItemsError | AuthorTaggedError,
    unknown
  > {
    if (!this._inputFn) {
      return Effect.fail(
        new ForEachStepRequiresItemsError({ stepPath: this.stepKey }),
      )
    }
    return this._inputFn(state, ctx)
  }

  /**
   * Get the forEach items for this step.
   * Returns the array of items, where each item IS the input for one execution.
   * Only available when forEach is configured.
   */
  forEachItems(
    state: TState,
    ctx: FlowContext<TSteps>,
  ): Effect.Effect<
    ReadonlyArray<TInput>,
    NotAForEachStepError | AuthorTaggedError,
    unknown
  > {
    if (!this._forEachItemsFn) {
      return Effect.fail(new NotAForEachStepError({ stepPath: this.stepKey }))
    }
    return this._forEachItemsFn(state, ctx)
  }

  /**
   * Execute the step logic with the derived input.
   * Subclasses must implement this method.
   *
   * The execute function may use Effect services (via yield*) and may fail
   * with tagged domain errors. These requirements and errors are propagated
   * when the step is executed by the SystemStepExecutor.
   *
   * @param input - Input derived from process state
   * @returns Effect producing the output to merge into state
   */
  abstract execute(
    input: TInput,
  ): Effect.Effect<InferSchemaType<TOutput>, AuthorTaggedError, unknown>

  /**
   * Execute the step with derived input.
   * This is the main entry point used by SystemStepExecutor for non-forEach steps.
   * For forEach steps, the executor calls execute(input) directly with item_data.
   */
  executeWithInput(
    state: TState,
    ctx: FlowContext<TSteps>,
  ): Effect.Effect<
    InferSchemaType<TOutput>,
    ForEachStepRequiresItemsError | AuthorTaggedError,
    unknown
  > {
    return Effect.gen(this, function* () {
      const input = yield* this.input(state, ctx)
      return yield* this.execute(input)
    })
  }

  /**
   * Execute the step and wrap output as a StepResult.
   *
   * The default implementation calls `execute()` and returns `Completed`.
   * Runtime/platform decides where and how this code runs (for example,
   * inline in a worker or dispatched to another runtime for long-duration
   * steps).
   *
   * @param input - Pre-computed input for the step
   * @param _jobContext - Job identifiers (todoId, stepPath) for external dispatch
   * @returns A StepResult indicating whether the step completed or was deferred
   */
  executeStep(
    input: TInput,
    _jobContext: StepJobContext,
  ): Effect.Effect<StepResult, AuthorTaggedError, unknown> {
    return Effect.map(this.execute(input), (output) => ({
      _tag: "Completed" as const,
      output: output as Record<string, unknown>,
    }))
  }

  onError<
    TNextState,
    TNextOutput extends Schema.Struct.Fields | undefined,
    TNextId extends string,
    TNextIsForm extends boolean = false,
    TNextIsForEach extends boolean = false,
  >(
    target: Step<TNextState, TNextOutput, TNextId, TNextIsForm, TNextIsForEach>,
    options?: OnErrorOptions,
  ): FlowPath<
    TNextIsForEach extends true
      ? TState & ForEachOutput<TNextId, TNextOutput, TNextIsForm>
      : MergeState<TState, ResolveStepOutput<TNextOutput, TNextIsForm>>,
    TNextOutput,
    TNextIsForm extends true
      ? MergeFormStep<TSteps, TNextId>
      : MergeSteps<TSteps, TNextId>
  > {
    return createOnErrorFlowPath<
      TState,
      TSteps,
      TNextOutput,
      TNextId,
      TNextIsForm,
      TNextIsForEach
    >(this, target, this.process, options)
  }
}
