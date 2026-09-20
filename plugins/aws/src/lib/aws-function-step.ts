import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda"
import { Data, Effect, Schema } from "effect"
import {
  type FlowPath,
  type FormStepMeta,
  type IStepScope,
  type InferSchemaType,
  type Process,
  type StepMeta,
  SystemStep,
  type SystemStepProps,
} from "@pf/process"

/**
 * Props for AwsFunctionStep - invokes an AWS Lambda function.
 *
 * @typeParam TState - Accumulated state from previous steps
 * @typeParam TSteps - Record of completed step metadata for ctx.step access
 * @typeParam TInput - Input derived from state (must be JSON-serializable)
 * @typeParam TOutput - Output schema fields merged into process state
 * @typeParam TIsForEach - Whether this step uses forEach semantics
 */
export type AwsFunctionStepProps<
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
   * Name of the AWS Lambda function to invoke.
   * Can be a function name or a full ARN.
   */
  readonly functionName: string
}

// Lazily cached Lambda client at module level
let lambdaClient: LambdaClient | undefined

const JsonValue = Schema.parseJson(Schema.Unknown)

function getLambdaClient(): LambdaClient {
  if (!lambdaClient) {
    lambdaClient = new LambdaClient({})
  }
  return lambdaClient
}

/**
 * AwsFunctionStep invokes an AWS Lambda function during step execution.
 *
 * The input is JSON-serialized and passed to the Lambda function.
 * The Lambda response is parsed and returned as the step output.
 *
 * @typeParam TState - Accumulated state from previous steps
 * @typeParam TSteps - Record of completed step metadata for ctx.step access
 * @typeParam TInput - Input derived from state (must be JSON-serializable)
 * @typeParam TOutput - Output schema fields merged into process state
 * @typeParam TId - Step identifier literal type
 *
 * @example
 * ```typescript
 * const addNumbers = new AwsFunctionStep(register, "AddNumbers", {
 *   functionName: "demo-add-numbers",
 *   input: (state) => Effect.succeed({ a: state.x, b: state.y }),
 *   output: { result: Schema.Number },
 * })
 * ```
 */
export class AwsFunctionStep<
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
   * Name of the AWS Lambda function to invoke.
   * Exposed for CDK to discover and grant permissions.
   */
  readonly functionName: string

  constructor(
    scope:
      | Process
      | IStepScope<TState, TSteps>
      | FlowPath<TState, Schema.Struct.Fields | undefined, TSteps>,
    id: TId,
    // biome-ignore lint/suspicious/noExplicitAny: Discriminated union requires relaxed typing in constructor
    props: AwsFunctionStepProps<TState, TSteps, TInput, TOutput, any>,
  ) {
    super(scope, id, props)
    this.functionName = props.functionName
  }

  /**
   * Execute the Lambda function with the derived input.
   *
   * The input is JSON-serialized and sent to the Lambda function.
   * The Lambda's response payload is parsed as JSON and returned.
   *
   * Error handling:
   * - SDK errors are wrapped in Effect.fail
   * - Lambda execution errors (FunctionError field) are detected and failed
   */
  execute(
    input: TInput,
  ): Effect.Effect<InferSchemaType<TOutput>, AwsFunctionError, unknown> {
    return Effect.gen(this, function* () {
      const client = getLambdaClient()

      const payloadJson = yield* Schema.encode(JsonValue)(input).pipe(
        Effect.mapError(
          (cause) =>
            new AwsFunctionError({
              message: `Failed to encode Lambda payload for "${this.functionName}"`,
              cause,
            }),
        ),
      )

      const payload = new TextEncoder().encode(payloadJson)

      yield* Effect.log(`Invoking Lambda function: ${this.functionName}`, {
        input: payloadJson,
      })

      const command = new InvokeCommand({
        FunctionName: this.functionName,
        Payload: payload,
      })

      const response = yield* Effect.tryPromise({
        try: () => client.send(command),
        catch: (error) =>
          new AwsFunctionError({
            message: `Failed to invoke Lambda function "${this.functionName}": ${error instanceof Error ? error.message : String(error)}`,
            cause: error,
          }),
      })

      // Check for Lambda execution errors (e.g., function threw an exception)
      if (response.FunctionError) {
        const errorPayload = response.Payload
          ? new TextDecoder().decode(response.Payload)
          : "Unknown error"
        return yield* new AwsFunctionError({
          message: `Lambda function "${this.functionName}" returned an error: ${errorPayload}`,
        })
      }

      // Parse the response payload as JSON
      if (!response.Payload || response.Payload.length === 0) {
        return yield* new AwsFunctionError({
          message: `Lambda function "${this.functionName}" returned empty response`,
        })
      }

      const responseText = new TextDecoder().decode(response.Payload)

      yield* Effect.log(
        `Lambda function ${this.functionName} returned response`,
        {
          responseLength: responseText.length,
        },
      )

      const result = yield* Schema.decodeUnknown(JsonValue)(responseText).pipe(
        Effect.map((value) => value as InferSchemaType<TOutput>),
        Effect.mapError(
          (error) =>
            new AwsFunctionError({
              message: `Failed to parse Lambda response from "${this.functionName}": ${String(error)}. Response: ${responseText.slice(0, 200)}`,
              cause: error,
            }),
        ),
      )

      yield* Effect.log(
        `Lambda function ${this.functionName} completed successfully`,
      )

      return result
    })
  }
}

/**
 * Error thrown when AWS Lambda function invocation fails.
 */
export class AwsFunctionError extends Data.TaggedError("AwsFunctionError")<{
  readonly message: string
  readonly cause?: unknown
}> {}
