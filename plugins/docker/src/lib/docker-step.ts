import {
  type ExecutorDescriptor,
  ExecutorError,
  ExecutorHost,
} from "@processfocus/runtime"
import { Effect, type Schema as SchemaNamespace } from "effect"
import {
  type AuthorTaggedError,
  type FlowContext,
  type FlowPath,
  type FormStepMeta,
  type IStepScope,
  type InferSchemaType,
  type Phase,
  type Process,
  type SlaConfig,
  type StepJobContext,
  type StepMeta,
  type StepResult,
  SystemStep,
  type SystemStepProps,
} from "@pf/process"

export type DockerStepProps<
  TState = Record<string, never>,
  TSteps extends Record<string, StepMeta | FormStepMeta> = Record<
    string,
    never
  >,
  TInput = unknown,
  TOutput extends SchemaNamespace.Struct.Fields = SchemaNamespace.Struct.Fields,
  TIsForEach extends boolean = false,
> = {
  readonly name?: string
  readonly purpose?: string
  readonly phase?: Phase
  readonly sla?: SlaConfig
  readonly dockerContext: string
  readonly dockerfile?: string
  readonly command?: string
  readonly executor?: ExecutorDescriptor
  readonly output: TOutput
  /**
   * Maximum number of retry attempts when the step fails.
   * - `0`: No retries - fail immediately on first error
   * - `1+`: Retry up to this many times after failure
   * - `undefined`: Use system default (typically 5)
   */
  readonly retries?: number
} & (TIsForEach extends true
  ? {
      forEach: {
        readonly items: (
          state: TState,
          ctx: FlowContext<TSteps>,
        ) => Effect.Effect<ReadonlyArray<TInput>, AuthorTaggedError, unknown>
      }
      input?: never
    }
  : {
      input: (
        state: TState,
        ctx: FlowContext<TSteps>,
      ) => Effect.Effect<TInput, AuthorTaggedError, unknown>
      forEach?: never
    })

export class DockerStep<
  TState = Record<string, never>,
  TSteps extends Record<string, StepMeta | FormStepMeta> = Record<
    string,
    never
  >,
  TInput = unknown,
  TOutput extends SchemaNamespace.Struct.Fields = SchemaNamespace.Struct.Fields,
  TId extends string = string,
  TIsForEach extends boolean = false,
> extends SystemStep<TState, TSteps, TInput, TOutput, TId, TIsForEach> {
  readonly isDockerStep = true
  readonly dockerContext: string
  readonly dockerfile: string
  readonly command: string | undefined
  readonly executor: ExecutorDescriptor | undefined

  constructor(
    scope:
      | Process
      | IStepScope<TState, TSteps>
      | FlowPath<TState, SchemaNamespace.Struct.Fields | undefined, TSteps>,
    id: TId,
    props: DockerStepProps<TState, TSteps, TInput, TOutput, TIsForEach>,
  ) {
    // DockerStepProps and SystemStepProps have identical structure (both use the
    // same forEach/input conditional union). We construct the SystemStepProps by
    // omitting DockerStep-specific fields (dockerContext, dockerfile) and adding
    // the SystemStep-required longDuration field. The spread of baseProps includes
    // retries, name, purpose, phase, sla, and output fields.
    const {
      dockerContext: _,
      dockerfile: __,
      command: ___,
      executor: ____,
      ...baseProps
    } = props
    const systemStepProps = {
      ...baseProps,
      longDuration: false,
    } as unknown as SystemStepProps<TState, TSteps, TInput, TOutput, TIsForEach>

    super(scope, id, systemStepProps)
    this.dockerContext = props.dockerContext
    this.dockerfile = props.dockerfile ?? "Dockerfile"
    this.command = props.command
    this.executor = props.executor
  }

  override execute(
    _input: TInput,
  ): Effect.Effect<InferSchemaType<TOutput>, ExecutorError, never> {
    return Effect.fail(
      new ExecutorError({
        message: `DockerStep "${this.stepKey}" must be executed via ExecutorHost`,
      }),
    )
  }

  override executeStep(
    input: TInput,
    jobContext: StepJobContext,
  ): Effect.Effect<StepResult, ExecutorError, ExecutorHost> {
    return Effect.flatMap(ExecutorHost, (runtime) =>
      runtime.run(
        {
          source: {
            context: this.dockerContext,
            definition: this.dockerfile,
          },
          input,
          ...(this.executor ? { descriptor: this.executor } : {}),
        },
        jobContext,
      ),
    )
  }
}
