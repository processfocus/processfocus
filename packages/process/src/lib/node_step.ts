import type { Effect, Schema } from "effect"
import type { FormStepMeta, StepMeta } from "./flow-context"
import type { FlowPath } from "./flow-path"
import type { InferSchemaType, Process } from "./process"
import type { IStepScope } from "./step"
import {
  type AuthorTaggedError,
  SystemStep,
  type SystemStepProps,
} from "./system-step"

/**
 * Props for NodeStep - a concrete SystemStep that takes execute as a prop.
 *
 * @typeParam TState - Accumulated state from previous steps
 * @typeParam TSteps - Record of completed step metadata for ctx.step access
 * @typeParam TInput - Input derived from state
 * @typeParam TOutput - Output schema fields merged into process state
 * @typeParam TIsForEach - Whether this step uses forEach semantics
 */
export type NodeStepProps<
  TState = Record<string, never>,
  TSteps extends Record<string, StepMeta | FormStepMeta> = Record<
    string,
    never
  >,
  TInput = unknown,
  TOutput extends Schema.Struct.Fields = Schema.Struct.Fields,
  TIsForEach extends boolean = false,
> = SystemStepProps<TState, TSteps, TInput, TOutput, TIsForEach> & {
  /**
   * The execute function containing the business logic.
   * Receives the derived input and returns the output to merge into state.
   *
   * The execute function may use Effect services (via yield*) and may fail
   * with tagged domain errors. These requirements and errors are propagated
   * when the step is executed by the SystemStepExecutor.
   */
  readonly execute: (
    input: TInput,
  ) => Effect.Effect<InferSchemaType<TOutput>, AuthorTaggedError, unknown>
}

/**
 * NodeStep is a concrete implementation of SystemStep that takes execute as a prop.
 *
 * This is the most common way to create system steps - you provide the execute
 * function directly as a prop rather than subclassing SystemStep.
 *
 * @typeParam TState - Accumulated state from previous steps
 * @typeParam TSteps - Record of completed step metadata for ctx.step access
 * @typeParam TInput - Input derived from state
 * @typeParam TOutput - Output schema fields merged into process state
 * @typeParam TId - Step identifier literal type
 * @typeParam TIsForEach - Whether this step uses forEach semantics
 *
 * @example
 * ```typescript
 * const greet = new NodeStep(register, "Greet", {
 *   input: (state) => Effect.succeed({ name: state.name }),
 *   output: {},
 *   execute: (input) => Effect.gen(function* () {
 *     console.log(`Hello ${input.name}`)
 *   }),
 * })
 *
 * this.start(register).next(greet).end()
 * ```
 */
export class NodeStep<
  TState = Record<string, never>,
  TSteps extends Record<string, StepMeta | FormStepMeta> = Record<
    string,
    never
  >,
  TInput = unknown,
  TOutput extends Schema.Struct.Fields = Schema.Struct.Fields,
  TId extends string = string,
  TIsForEach extends boolean = false,
> extends SystemStep<TState, TSteps, TInput, TOutput, TId, TIsForEach> {
  /**
   * The execute function provided as a prop.
   */
  private _executeFn: (
    input: TInput,
  ) => Effect.Effect<InferSchemaType<TOutput>, AuthorTaggedError, unknown>

  constructor(
    scope:
      | Process
      | IStepScope<TState, TSteps>
      | FlowPath<TState, Schema.Struct.Fields | undefined, TSteps>,
    id: TId,
    // biome-ignore lint/suspicious/noExplicitAny: Discriminated union requires relaxed typing in constructor
    props: NodeStepProps<TState, TSteps, TInput, TOutput, any>,
  ) {
    super(scope, id, props)
    this._executeFn = props.execute
  }

  /**
   * Execute the step logic with the derived input.
   * Delegates to the execute prop.
   *
   * The returned Effect may have requirements (services) and tagged domain
   * errors that are propagated when the step is executed by the
   * SystemStepExecutor.
   */
  override execute(
    input: TInput,
  ): Effect.Effect<InferSchemaType<TOutput>, AuthorTaggedError, unknown> {
    return this._executeFn(input)
  }
}
