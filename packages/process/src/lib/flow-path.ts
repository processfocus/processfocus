import type { Schema } from "effect"
import type {
  ForEachOutput,
  FormStepMeta,
  MergeFormStep,
  MergeSteps,
  StepMeta,
} from "./flow-context"
import type {
  Condition,
  Process,
  ResolveStepOutput,
  ScheduleFn,
} from "./process"
import type { IStepScope, Step } from "./step"

/**
 * Options for conditional edges in the flow.
 * @deprecated Use TransitionOptions instead for new code
 */
export interface ConditionOptions<TState> {
  condition: {
    fn: Condition<TState>
    text?: string
  }
}

/**
 * Options for scheduled edges in the flow.
 */
export interface ScheduleOptions<
  TState,
  TSteps extends Record<string, StepMeta | FormStepMeta> = Record<
    string,
    never
  >,
> {
  schedule: {
    fn: ScheduleFn<TState, TSteps>
    text?: string
  }
}

/**
 * Combined options for flow transitions.
 * Supports both condition (boolean-based) and schedule (ScheduledTime-based) triggers.
 * They can coexist on the same edge.
 */
export interface TransitionOptions<
  TState,
  TSteps extends Record<string, StepMeta | FormStepMeta> = Record<
    string,
    never
  >,
> {
  condition?: {
    fn: Condition<TState>
    text?: string
  }
  schedule?: {
    fn: ScheduleFn<TState, TSteps>
    text?: string
  }
}

export interface OnErrorOptions {
  taggedErrors?: readonly string[]
}

export interface ElseTransitionOptions {
  text?: string
}

export type MergeState<TState, TOutput> = [TOutput] extends [
  Record<string, never>,
]
  ? TState
  : TState & TOutput

type AnyStep = Step<
  // biome-ignore lint/suspicious/noExplicitAny: TState is unconstrained
  any,
  Schema.Struct.Fields | undefined,
  string,
  boolean,
  boolean>

export function assertSameProcess(step: AnyStep, process: Process) {
  if (step.process !== process) {
    throw new Error(
      `Step "${step.node.path}" belongs to a different process than "${process.node.path}"`,
    )
  }
}

/**
 * Wraps a step in a FlowPath without adding an edge.
 * Used by Process.start() which handles edge creation separately.
 */
export function wrapInFlowPath<
  TState,
  TOutput extends Schema.Struct.Fields | undefined,
  TSteps extends Record<string, StepMeta | FormStepMeta> = Record<
    string,
    never
  >,
  TIsForm extends boolean = false,
>(
  step: Step<TState, TOutput, string, TIsForm, boolean>,
  process: Process,
): FlowPath<TState, TOutput, TSteps> {
  assertSameProcess(step, process)
  return new FlowPath(
    step as Step<TState, TOutput, string, boolean, boolean>,
    process,
  )
}

/**
 * Creates a FlowPath by connecting two steps with an edge.
 * This is the core implementation used by both Step.next() and FlowPath.next().
 *
 * Note: The type assertion on toStep is safe because TState is a phantom type
 * (Step.__scopeState is never populated at runtime). We're reinterpreting the
 * Step's type-level state to include accumulated state from the flow.
 *
 * @typeParam TIsForm - Whether the target step is a Form (determines meta type)
 * @typeParam TIsForEach - Whether the target step is a forEach step (array state)
 */
export function createFlowPath<
  TState,
  TSteps extends Record<string, StepMeta | FormStepMeta>,
  TNextOutput extends Schema.Struct.Fields | undefined,
  TNextId extends string,
  TIsForm extends boolean = false,
  TIsForEach extends boolean = false,
>(
  fromStep: AnyStep,
  toStep: AnyStep,
  process: Process,
  options?: TransitionOptions<TState, TSteps>,
): FlowPath<
  TIsForEach extends true
    ? TState & ForEachOutput<TNextId, TNextOutput, TIsForm>
    : MergeState<TState, ResolveStepOutput<TNextOutput, TIsForm>>,
  TNextOutput,
  TIsForm extends true
    ? MergeFormStep<TSteps, TNextId>
    : MergeSteps<TSteps, TNextId>
> {
  assertSameProcess(fromStep, process)
  assertSameProcess(toStep, process)
  process.addEdge(fromStep, toStep, {
    condition: options?.condition?.fn,
    conditionText: options?.condition?.text,
    schedule: options?.schedule?.fn,
    scheduleText: options?.schedule?.text,
  })
  // Safe: TState is a phantom type for compile-time state tracking only
  return new FlowPath(
    toStep as Step<
      TIsForEach extends true
        ? TState & ForEachOutput<TNextId, TNextOutput, TIsForm>
        : MergeState<TState, ResolveStepOutput<TNextOutput, TIsForm>>,
      TNextOutput,
      string,
      boolean,
      boolean
    >,
    process,
  )
}

export function createOnErrorFlowPath<
  TState,
  TSteps extends Record<string, StepMeta | FormStepMeta>,
  TNextOutput extends Schema.Struct.Fields | undefined,
  TNextId extends string,
  TNextIsForm extends boolean = false,
  TNextIsForEach extends boolean = false,
>(
  fromStep: AnyStep,
  toStep: AnyStep,
  process: Process,
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
  assertSameProcess(fromStep, process)
  assertSameProcess(toStep, process)
  process.addEdge(fromStep, toStep, {
    isOnError: true,
    ...(options?.taggedErrors !== undefined && {
      taggedErrors: options.taggedErrors,
    }),
  })
  return new FlowPath(
    toStep as Step<
      TNextIsForEach extends true
        ? TState & ForEachOutput<TNextId, TNextOutput, TNextIsForm>
        : MergeState<TState, ResolveStepOutput<TNextOutput, TNextIsForm>>,
      TNextOutput,
      string,
      boolean,
      boolean
    >,
    process,
  )
}

/**
 * FlowPath represents a position in a process flow with accumulated state and step metadata.
 *
 * @typeParam TState - Accumulated state type from completed steps
 * @typeParam TOutput - Output schema of the current step
 * @typeParam TSteps - Record of completed step metadata, keyed by camelCase step ID
 */
export class FlowPath<
  TState,
  TOutput extends Schema.Struct.Fields | undefined,
  TSteps extends Record<string, StepMeta | FormStepMeta> = Record<
    string,
    never
  >,
> implements IStepScope<TState, TSteps>
{
  readonly process: Process
  /** Phantom type field to carry accumulated state for type inference */
  readonly __scopeState?: TState
  /** Phantom type field to carry completed steps for type inference */
  readonly __scopeSteps?: TSteps

  constructor(
    readonly step: Step<TState, TOutput, string, boolean, boolean>,
    process: Process,
  ) {
    this.process = process
  }

  // No-arg: mark current step as terminal
  end(): Step<TState, TOutput, string, boolean, boolean>
  // With step: transition to step AND mark as terminal (shorthand for .next(step).end())
  end<
    TEndState,
    TEndOutput extends Schema.Struct.Fields | undefined,
    TEndIsForm extends boolean = false,
    TEndIsForEach extends boolean = false,
  >(
    step: Step<TEndState, TEndOutput, string, TEndIsForm, TEndIsForEach>,
    options?: TransitionOptions<TState>,
  ): Step<
    TEndIsForEach extends true
      ? TState & ForEachOutput<string, TEndOutput, TEndIsForm>
      : MergeState<TState, ResolveStepOutput<TEndOutput, TEndIsForm>>,
    TEndOutput,
    string,
    TEndIsForm
  >

  end<
    TEndState,
    TEndOutput extends Schema.Struct.Fields | undefined,
    TEndIsForm extends boolean = false,
    TEndIsForEach extends boolean = false,
  >(
    step?: Step<TEndState, TEndOutput, string, TEndIsForm, TEndIsForEach>,
    options?: TransitionOptions<TState>,
  ):
    | Step<TState, TOutput, string, boolean, boolean>
    | Step<
        TEndIsForEach extends true
          ? TState & ForEachOutput<string, TEndOutput, TEndIsForm>
          : MergeState<TState, ResolveStepOutput<TEndOutput, TEndIsForm>>,
        TEndOutput,
        string,
        TEndIsForm
      > {
    if (step) {
      // Shorthand: transition to step AND mark as terminal
      assertSameProcess(step, this.process)
      this.step.process.addEdge(this.step, step, {
        condition: options?.condition?.fn,
        conditionText: options?.condition?.text,
        schedule: options?.schedule?.fn,
        scheduleText: options?.schedule?.text,
      })
      this.process.addEndEdge(step)
      // Safe: TState is a phantom type for compile-time state tracking only
      return step as Step<
        TEndIsForEach extends true
          ? TState & ForEachOutput<string, TEndOutput, TEndIsForm>
          : MergeState<TState, ResolveStepOutput<TEndOutput, TEndIsForm>>,
        TEndOutput,
        string,
        TEndIsForm
      >
    }
    // No-arg: mark current step as terminal
    this.process.addEndEdge(this.step)
    return this.step
  }

  next<
    TNextState,
    TNextOutput extends Schema.Struct.Fields | undefined,
    TNextId extends string,
    TNextIsForm extends boolean = false,
    TNextIsForEach extends boolean = false,
  >(
    target: Step<TNextState, TNextOutput, TNextId, TNextIsForm, TNextIsForEach>,
    options?: TransitionOptions<TState, TSteps>,
  ): FlowPath<
    TNextIsForEach extends true
      ? TState & ForEachOutput<TNextId, TNextOutput, TNextIsForm>
      : MergeState<TState, ResolveStepOutput<TNextOutput, TNextIsForm>>,
    TNextOutput,
    TNextIsForm extends true
      ? MergeFormStep<TSteps, TNextId>
      : MergeSteps<TSteps, TNextId>
  > {
    return createFlowPath<
      TState,
      TSteps,
      TNextOutput,
      TNextId,
      TNextIsForm,
      TNextIsForEach
    >(this.step, target, this.process, options)
  }

  /**
   * Returns an ElseBranch that can be used to define the else edge.
   * The else edge is followed ONLY if NO conditional edges match.
   *
   * @example
   * flow.next(stepApproved, (s) => s.approved)
   * flow.else().next(stepRejected).end()
   */
  else(): ElseBranch<TState, TOutput, TSteps> {
    return new ElseBranch(this.step, this.process)
  }

  /**
   * Shorthand for .else().end() - creates an else edge to __end__.
   */
  elseEnd(): Step<TState, TOutput, string, boolean, boolean>
  /**
   * Shorthand for .else().end(step) - creates an else edge to step AND marks as terminal.
   */
  elseEnd<
    TEndState,
    TEndOutput extends Schema.Struct.Fields | undefined,
    TEndIsForm extends boolean = false,
  >(
    step: Step<TEndState, TEndOutput, string, TEndIsForm, boolean>,
    options?: ElseTransitionOptions,
  ): Step<
    MergeState<TState, ResolveStepOutput<TEndOutput, TEndIsForm>>,
    TEndOutput,
    string,
    TEndIsForm
  >

  elseEnd<
    TEndState,
    TEndOutput extends Schema.Struct.Fields | undefined,
    TEndIsForm extends boolean = false,
  >(
    step?: Step<TEndState, TEndOutput, string, TEndIsForm, boolean>,
    options?: ElseTransitionOptions,
  ):
    | Step<TState, TOutput, string, boolean, boolean>
    | Step<
        MergeState<TState, ResolveStepOutput<TEndOutput, TEndIsForm>>,
        TEndOutput,
        string,
        TEndIsForm
      > {
    if (step) {
      return this.else().end(step, options)
    }
    return this.else().end()
  }

  /**
   * Shorthand for .else().next(target) - creates an else edge to target step.
   */
  elseNext<
    TNextState,
    TNextOutput extends Schema.Struct.Fields | undefined,
    TNextIsForm extends boolean = false,
  >(
    target: Step<TNextState, TNextOutput, string, TNextIsForm, boolean>,
    options?: ElseTransitionOptions,
  ): FlowPath<
    MergeState<TState, ResolveStepOutput<TNextOutput, TNextIsForm>>,
    TNextOutput,
    TSteps
  > {
    return this.else().next(target, options)
  }
}

/**
 * Represents an else branch from a flow path.
 * The else edge is followed ONLY if NO conditional edges from the source step match.
 */
export class ElseBranch<
  TState,
  TOutput extends Schema.Struct.Fields | undefined,
  TSteps extends Record<string, StepMeta | FormStepMeta> = Record<
    string,
    never
  >,
> {
  constructor(
    readonly step: Step<TState, TOutput, string, boolean, boolean>,
    readonly process: Process,
  ) {}

  /**
   * Create an else edge to the next step.
   */
  next<
    TNextState,
    TNextOutput extends Schema.Struct.Fields | undefined,
    TNextIsForm extends boolean = false,
  >(
    target: Step<TNextState, TNextOutput, string, TNextIsForm, boolean>,
    options?: ElseTransitionOptions,
  ): FlowPath<
    MergeState<TState, ResolveStepOutput<TNextOutput, TNextIsForm>>,
    TNextOutput,
    TSteps
  > {
    assertSameProcess(target, this.process)
    this.process.addEdge(this.step, target, {
      isElse: true,
      conditionText: options?.text,
    })
    return new FlowPath(
      target as Step<
        MergeState<TState, ResolveStepOutput<TNextOutput, TNextIsForm>>,
        TNextOutput,
        string,
        boolean,
        boolean
      >,
      this.process,
    )
  }

  // No-arg: mark current step as terminal with else edge
  end(): Step<TState, TOutput, string, boolean, boolean>
  // With step: transition to step with else edge AND mark as terminal
  end<
    TEndState,
    TEndOutput extends Schema.Struct.Fields | undefined,
    TEndIsForm extends boolean = false,
  >(
    step: Step<TEndState, TEndOutput, string, TEndIsForm, boolean>,
    options?: ElseTransitionOptions,
  ): Step<
    MergeState<TState, ResolveStepOutput<TEndOutput, TEndIsForm>>,
    TEndOutput,
    string,
    TEndIsForm
  >

  end<
    TEndState,
    TEndOutput extends Schema.Struct.Fields | undefined,
    TEndIsForm extends boolean = false,
  >(
    step?: Step<TEndState, TEndOutput, string, TEndIsForm, boolean>,
    options?: ElseTransitionOptions,
  ):
    | Step<TState, TOutput, string, boolean, boolean>
    | Step<
        MergeState<TState, ResolveStepOutput<TEndOutput, TEndIsForm>>,
        TEndOutput,
        string,
        TEndIsForm
      > {
    if (step) {
      // Transition to step with else edge AND mark as terminal
      assertSameProcess(step, this.process)
      this.process.addEdge(this.step, step, {
        isElse: true,
        conditionText: options?.text,
      })
      this.process.addEndEdge(step)
      return step as Step<
        MergeState<TState, ResolveStepOutput<TEndOutput, TEndIsForm>>,
        TEndOutput,
        string,
        TEndIsForm
      >
    }
    // No-arg: mark current step as terminal with else edge to __end__
    this.process.addElseEndEdge(this.step)
    return this.step
  }
}
