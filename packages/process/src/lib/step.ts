import { Construct } from "constructs"
import { Schema } from "effect"
import { isProcess } from "./brands"
import type {
  ForEachOutput,
  FormStepMeta,
  MergeFormStep,
  MergeSteps,
  StepMeta,
} from "./flow-context"
import { toCamelCase } from "./flow-context"
import {
  type FlowPath,
  type TransitionOptions,
  assertSameProcess,
  createFlowPath,
} from "./flow-path"
import type { Phase } from "./phase"
import type { IProcessHolder, Process, ResolveStepOutput } from "./process"
import type { Role } from "./role"
import type { SlaConfig } from "./sla"

export interface StepProps<
  TOutput extends Schema.Struct.Fields | undefined = undefined,
> {
  readonly name?: string
  readonly purpose?: string

  /**
   * A step is executed by a human or a system.
   * This is the primary role for the step.
   *
   * For user-executed steps (Form), this is required.
   * For system-executed steps (SystemStep), this is undefined.
   * In the database, `role_id = NULL` indicates a system step.
   */
  readonly role?: Role

  /**
   * The output schema this step contributes to process state.
   * For Forms, this is the form fields. For SystemSteps, the output schema.
   */
  readonly output?: TOutput

  /**
   * Optional visual indicator in swimlane.
   * Steps of the same phase are kept together.
   */
  readonly phase?: Phase

  /**
   * Optional SLA (Service Level Agreement) for this step.
   * Specifies the maximum duration for this step to complete,
   * measured in business calendar time from when the step becomes active.
   */
  readonly sla?: SlaConfig

  /**
   * Always send todo-assignment notifications for this step, even when the
   * recipient has disabled optional todo-assignment emails.
   */
  readonly alwaysNotify?: boolean
}

// Type utility to merge two state types
type EmptyObject = Record<string, never>

type MergeState<TState, TOutput> = [TOutput] extends [EmptyObject]
  ? TState
  : TState & TOutput

/**
 * Interface for anything that can be a scope for creating Steps.
 * Extends IProcessHolder to access the Process, and adds phantom type
 * fields to carry accumulated state and steps information for type inference.
 */
export interface IStepScope<
  TState = Record<string, never>,
  TSteps extends Record<string, StepMeta | FormStepMeta> = Record<
    string,
    never
  >,
> extends IProcessHolder {
  /** Phantom type to carry state information */
  readonly __scopeState?: TState
  /** Phantom type to carry completed steps information */
  readonly __scopeSteps?: TSteps
}

export abstract class Step<
    TState = Record<string, never>,
    TOutput extends Schema.Struct.Fields | undefined = undefined,
    TId extends string = string,
    TIsForm extends boolean = false,
    TIsForEach extends boolean = false,
  >
  extends Construct
  implements IStepScope<TState>
{
  // TODO: probably drop this?
  readonly props: StepProps<TOutput>

  private _output: TOutput | undefined
  private _outputSchema: Schema.Schema.Any | undefined

  // Our parent
  readonly process: Process
  readonly __scopeState?: TState // Phantom type field

  /**
   * Phantom type to carry the step ID as a literal type.
   * Used for type-level step key computation.
   */
  readonly __stepId?: TId

  /**
   * Phantom type to indicate if this step is a Form (completed by employee).
   * Forms set this to `true` while generic Steps leave it as `false`.
   */
  readonly __isForm?: TIsForm

  /**
   * Phantom type to indicate if this step uses forEach semantics.
   * When true, the step contributes an array of outputs to state
   * instead of a flat merge.
   */
  readonly __isForEach?: TIsForEach

  /**
   * The step ID converted to a valid camelCase identifier.
   * Used as the key in ctx.step for this step.
   */
  readonly stepKey: string

  /** Stable brand for steps loaded from separately bundled organisation code. */
  readonly isStep: true = true

  /**
   * Brand property to identify Form instances across bundle boundaries.
   * Overridden to `true` in Form. Check this instead of using instanceof,
   * which fails when org.js is compiled separately from the job worker.
   */
  readonly isForm: boolean = false

  /**
   * Brand property to identify SystemStep instances across bundle boundaries.
   * Overridden to `true` in SystemStep. Check this instead of using instanceof,
   * which fails when org.js is compiled separately from the job worker.
   */
  readonly isSystemStep: boolean = false

  /**
   * The output validation schema for this step.
   * Lazily builds Schema.Struct from output fields on first access.
   * Form overrides this to include struct-level validation refinements.
   */
  get outputSchema(): Schema.Schema.Any | undefined {
    if (!this._outputSchema && this._output) {
      this._outputSchema = Schema.Struct(this._output)
    }
    return this._outputSchema
  }

  /**
   * The flat submission validation schema for this step.
   * Returns `undefined` for non-Form steps. Form overrides this to return
   * the flattened submission schema (wrapper fields removed, read-only/
   * structural-only excluded), optionally with a filterEffect refinement.
   *
   * Used by start/complete resolvers for server-side validation.
   */
  get submissionEffectSchema(): Schema.Schema.Any | undefined {
    return undefined
  }

  /**
   * Brand property to identify forEach steps across bundle boundaries.
   * Overridden to `true` in SystemStep/Form when forEach is configured.
   */
  readonly hasForEach: boolean = false

  constructor(
    // biome-ignore lint/suspicious/noExplicitAny: Step doesn't use TSteps, only Form does
    scope: Process | IStepScope<TState, any>,
    id: TId,
    props: StepProps<TOutput>,
  ) {
    // Extract the Process from either a Process or a Step-like object
    const process = isProcess(scope) ? scope : scope.process
    super(process, id)
    this.process = process
    this._output = props.output
    this.props = props
    // Compute camelCase key for ctx.step access
    this.stepKey = toCamelCase(id)
    // Add this step as a node when it's part of a process
    process.addNode(this)
  }

  /**
   * Get the output schema for this step.
   */
  get output(): TOutput | undefined {
    return this._output
  }

  /**
   * Connect `step` to this step. Optionally provide transition options.
   * @param step - The next step to connect to
   * @param options - Optional transition options with `condition` and/or `schedule`
   */
  next<
    TNextState,
    TNextOutput extends Schema.Struct.Fields | undefined,
    TNextId extends string,
    TNextIsForm extends boolean = false,
    TNextIsForEach extends boolean = false,
  >(
    step: Step<TNextState, TNextOutput, TNextId, TNextIsForm, TNextIsForEach>,
    options?: TransitionOptions<TState>,
  ): FlowPath<
    TNextIsForEach extends true
      ? TState & ForEachOutput<TNextId, TNextOutput, TNextIsForm>
      : MergeState<TState, ResolveStepOutput<TNextOutput, TNextIsForm>>,
    TNextOutput,
    TNextIsForm extends true
      ? MergeFormStep<Record<string, never>, TNextId>
      : MergeSteps<Record<string, never>, TNextId>
  > {
    return createFlowPath(this, step, this.process, options)
  }

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
  > {
    assertSameProcess(step, this.process)
    this.process.addEdge(this, step, {
      condition: options?.condition?.fn,
      conditionText: options?.condition?.text,
      schedule: options?.schedule?.fn,
      scheduleText: options?.schedule?.text,
    })
    this.process.addEndEdge(step)

    return step as Step<
      TEndIsForEach extends true
        ? TState & ForEachOutput<string, TEndOutput, TEndIsForm>
        : MergeState<TState, ResolveStepOutput<TEndOutput, TEndIsForm>>,
      TEndOutput,
      string,
      TEndIsForm
    >
  }
}
