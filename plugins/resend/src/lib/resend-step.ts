import { Effect, Encoding, Option, Schema } from "effect"
import { DocumentStoreService } from "@pf/document-store-service"
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
  StepProcessStateReader,
  type StepResult,
  SystemStep,
} from "@pf/process"
import {
  type ResendApiAttachment,
  ResendClient,
  ResendDeferredDelivery,
  type ResendEmailRequest,
  type ResendEmailTemplate,
  ResendError,
} from "./resend-client"

/**
 * An attachment backed by the document store.
 * The file content is fetched server-side and base64-encoded for the
 * Resend API.
 */
export interface ResendEmailAttachment {
  readonly filename: string
  readonly storePrefix: string
  readonly fileId: string
}

/**
 * Input type for ResendEmailStep - the data needed to send an email.
 *
 * When sending with a Resend template:
 * - `from` and `subject` are optional if the template already defines them
 * - if `from` or `subject` are provided here, they override the template values
 */
export interface ResendEmailInput {
  readonly to: string | readonly string[]
  readonly subject?: string
  readonly html?: string
  readonly text?: string
  readonly template?: ResendEmailTemplate
  readonly from?: string
  readonly replyTo?: string | readonly string[]
  readonly cc?: string | readonly string[]
  readonly bcc?: string | readonly string[]
  readonly attachments?: readonly ResendEmailAttachment[]
}

/**
 * Output schema for ResendStep - returns the email ID from Resend API.
 */
export const resendOutput = {
  emailId: Schema.String,
}

/**
 * Configuration for forEach (multi-instance) steps in ResendStep.
 */
export interface ResendForEachConfig<
  TState,
  TSteps extends Record<string, StepMeta | FormStepMeta>,
> {
  readonly items: (
    state: TState,
    ctx: FlowContext<TSteps>,
  ) => Effect.Effect<
    ReadonlyArray<ResendEmailInput>,
    AuthorTaggedError,
    unknown
  >
}

/**
 * Props for ResendStep - sends emails via Resend API.
 *
 * @typeParam TState - Accumulated state from previous steps
 * @typeParam TSteps - Record of completed step metadata for ctx.step access
 * @typeParam TIsForEach - Whether this step uses forEach semantics
 */
export type ResendStepProps<
  TState = Record<string, never>,
  TSteps extends Record<string, StepMeta | FormStepMeta> = Record<
    string,
    never
  >,
  TIsForEach extends boolean = boolean,
> = {
  readonly name?: string
  readonly purpose?: string
  readonly phase?: Phase
  readonly sla?: SlaConfig
  /**
   * Default sender address, e.g. "Process Focus <noreply@processfocus.com>".
   * Optional when sending with a Resend template that already defines a sender.
   * If both are provided, the step/input value overrides the template default.
   */
  readonly from?: string
} & (TIsForEach extends true
  ? {
      forEach: ResendForEachConfig<TState, TSteps>
      input?: never
    }
  : {
      input: (
        state: TState,
        ctx: FlowContext<TSteps>,
      ) => Effect.Effect<ResendEmailInput>
      forEach?: never
    })

/**
 * ResendStep sends emails via the Resend API.
 *
 * Uses the shared Resend client from the plugin runtime layer.
 * Returns the email ID from Resend in the output.
 *
 * @typeParam TState - Accumulated state from previous steps
 * @typeParam TSteps - Record of completed step metadata for ctx.step access
 * @typeParam TId - Step identifier literal type
 * @typeParam TIsForEach - Whether this step uses forEach semantics
 *
 * @example
 * ```typescript
 * const sendConfirmation = new ResendStep(flow, "Send confirmation", {
 *   from: "Process Focus <noreply@processfocus.com>",
 *   input: (state) => Effect.succeed({
 *     to: [state.email],
 *     subject: "Your request has been approved",
 *     html: `<p>Hello ${state.name}, your request was approved.</p>`,
 *   }),
 * })
 * ```
 */
export class ResendStep<
  TState = Record<string, never>,
  TSteps extends Record<string, StepMeta | FormStepMeta> = Record<
    string,
    never
  >,
  TId extends string = string,
  TIsForEach extends boolean = boolean,
> extends SystemStep<
  TState,
  TSteps,
  ResendEmailInput,
  typeof resendOutput,
  TId,
  TIsForEach
> {
  /**
   * Default sender address for emails.
   */
  readonly from: string | undefined

  constructor(
    scope:
      | Process
      | IStepScope<TState, TSteps>
      | FlowPath<TState, Schema.Struct.Fields | undefined, TSteps>,
    id: TId,
    // biome-ignore lint/suspicious/noExplicitAny: Discriminated union requires relaxed typing in constructor
    props: ResendStepProps<TState, TSteps, any>,
  ) {
    super(scope, id, {
      ...props,
      output: resendOutput,
    })
    this.from = props.from
  }

  /**
   * Validate input and resolve attachments. Shared by both execute() and
   * executeStep() to ensure consistent validation across modes.
   */
  private validateAndResolve(input: ResendEmailInput): Effect.Effect<
    {
      readonly sender: string | undefined
      readonly resolvedAttachments: ResendApiAttachment[] | undefined
    },
    ResendError,
    DocumentStoreService
  > {
    return Effect.gen(this, function* () {
      if (
        input.template &&
        (input.html !== undefined || input.text !== undefined)
      ) {
        return yield* new ResendError({
          message:
            "Email template cannot be combined with 'html' or 'text' content",
        })
      }

      if (!input.template && !input.html && !input.text) {
        return yield* new ResendError({
          message:
            "Email must include either 'html', 'text', or 'template' content",
        })
      }

      const sender = input.from ?? this.from

      if (!input.template && sender === undefined) {
        return yield* new ResendError({
          message:
            "Email with 'html' or 'text' content must include a 'from' address",
        })
      }

      if (!input.template && input.subject === undefined) {
        return yield* new ResendError({
          message:
            "Email with 'html' or 'text' content must include a 'subject'",
        })
      }

      let resolvedAttachments: ResendApiAttachment[] | undefined
      if (input.attachments && input.attachments.length > 0) {
        const docStore = yield* DocumentStoreService
        resolvedAttachments = []
        for (const att of input.attachments) {
          const { content } = yield* docStore
            .getFileContent(att.fileId, att.storePrefix)
            .pipe(
              Effect.mapError(
                (error) =>
                  new ResendError({
                    message: `Failed to fetch attachment "${att.filename}": ${String(error)}`,
                    cause: error,
                  }),
              ),
            )
          // Base64-encode for Resend API (platform-agnostic, no Node.js Buffer)
          const base64 = Encoding.encodeBase64(content)
          resolvedAttachments.push({
            filename: att.filename,
            content: base64,
          })
        }
      }

      return { sender, resolvedAttachments }
    })
  }

  /**
   * Build a ResendEmailRequest from input and resolved values.
   */
  private buildSendRequest(
    input: ResendEmailInput,
    sender: string | undefined,
    resolvedAttachments: ResendApiAttachment[] | undefined,
    tags?: readonly { readonly name: string; readonly value: string }[],
  ): ResendEmailRequest {
    return {
      to: input.to,
      ...(sender !== undefined && { from: sender }),
      ...(input.subject !== undefined && { subject: input.subject }),
      ...(input.html !== undefined && { html: input.html }),
      ...(input.text !== undefined && { text: input.text }),
      ...(input.template !== undefined && { template: input.template }),
      ...(input.replyTo !== undefined && { replyTo: input.replyTo }),
      ...(input.cc !== undefined && { cc: input.cc }),
      ...(input.bcc !== undefined && { bcc: input.bcc }),
      ...(resolvedAttachments !== undefined && {
        attachments: resolvedAttachments,
      }),
      ...(tags !== undefined && { tags }),
    }
  }

  /**
   * Execute the email send via Resend API.
   *
   * Delegates delivery to the shared plugin Resend client.
   * Returns the email ID from the Resend response.
   *
   * Error handling:
   * - API errors are wrapped in ResendError
   * - Non-2xx responses are failed
   */
  execute(
    input: ResendEmailInput,
  ): Effect.Effect<InferSchemaType<typeof resendOutput>, ResendError, unknown> {
    return Effect.gen(this, function* () {
      const resendClient = yield* ResendClient
      const { sender, resolvedAttachments } =
        yield* this.validateAndResolve(input)

      const result = yield* resendClient.sendEmail(
        this.buildSendRequest(input, sender, resolvedAttachments),
      )

      return { emailId: result.emailId }
    })
  }

  /**
   * Execute the step and wrap output as a StepResult.
   *
   * When the ResendDeferredDelivery capability is available (AWS runtime),
   * sends the email, tags it for webhook correlation, persists internal
   * tracking metadata into process state, and returns a deferred result.
   *
   * When the capability is absent (local runtime), falls back to the
   * default immediate-completion behavior.
   */
  override executeStep(
    input: ResendEmailInput,
    jobContext: StepJobContext,
  ): Effect.Effect<StepResult, AuthorTaggedError, unknown> {
    // Capture super reference outside Effect.gen (super is not accessible
    // inside generator functions).
    const superExecuteStep = super.executeStep.bind(this)

    return Effect.gen(this, function* () {
      const deferredOption = yield* Effect.serviceOption(ResendDeferredDelivery)

      return yield* Option.match(deferredOption, {
        onNone: () => superExecuteStep(input, jobContext),
        onSome: (deferred) =>
          this.executeDeferred(input, jobContext, deferred.environment),
      })
    })
  }

  /**
   * Deferred execution path: sends the email, tags it, returns state update.
   */
  private executeDeferred(
    input: ResendEmailInput,
    jobContext: StepJobContext,
    environment: string,
  ): Effect.Effect<StepResult, ResendError, unknown> {
    return Effect.gen(this, function* () {
      // Idempotency guard: if process state already has resend metadata,
      // the email was sent on a previous attempt that failed to mark the
      // job completed. Return deferred without re-sending.
      const readerOption = yield* Effect.serviceOption(StepProcessStateReader)
      const idempotent = yield* Option.match(readerOption, {
        onNone: () => Effect.succeed(false),
        onSome: (reader) =>
          Effect.gen(function* () {
            const state = yield* reader.getProcessStateByTodoId(
              jobContext.todoId,
            )
            const internal = state["_internal"] as
              | Record<string, unknown>
              | undefined
            return internal?.["resend"] !== undefined
          }),
      })
      if (idempotent) {
        return { _tag: "Deferred" as const }
      }

      // Deferred mode requires exactly one primary `to` recipient
      if (typeof input.to !== "string") {
        return yield* new ResendError({
          message:
            "Deferred Resend mode requires exactly one primary 'to' recipient (string), not an array",
        })
      }

      const resendClient = yield* ResendClient
      const { sender, resolvedAttachments } =
        yield* this.validateAndResolve(input)

      const result = yield* resendClient.sendEmail(
        this.buildSendRequest(input, sender, resolvedAttachments, [
          { name: "pf_todo_id", value: jobContext.todoId },
          { name: "pf_environment", value: environment },
        ]),
      )
      const primaryTo =
        typeof result.sentTo === "string" ? result.sentTo : input.to

      return {
        _tag: "Deferred" as const,
        stateUpdate: {
          _internal: {
            resend: {
              emailId: result.emailId,
              // Store the actual delivered-to recipient so rerouted sends still
              // complete from the Resend webhook callback.
              primaryTo,
              environment,
              todoId: jobContext.todoId,
            },
          },
        },
      }
    }).pipe(Effect.withSpan("ResendStep.executeDeferred"))
  }
}
