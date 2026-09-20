import { Effect, Schema } from "effect"
import {
  type AuthorTaggedError,
  type CurrentStepJobContext,
  type FlowContext,
  type FlowPath,
  type FormStepMeta,
  type IStepScope,
  type InferSchemaType,
  type Phase,
  type Process,
  type SlaConfig,
  type StepMeta,
  SystemStep,
} from "@pf/process"
import type { XeroInvoiceError } from "./errors"
import type { IssueAuthorisedSalesInvoiceInput } from "./identities"
import {
  XeroInvoice,
  decodeIssueAuthorisedSalesInvoiceInput,
} from "./xero-invoice"

export const xeroInvoiceOutput = {
  invoiceId: Schema.String,
  invoiceNumber: Schema.String,
}

export type XeroInvoiceStepProps<
  TState = Record<string, never>,
  TSteps extends Record<string, StepMeta | FormStepMeta> = Record<
    string,
    never
  >,
> = {
  readonly name?: string
  readonly purpose?: string
  readonly phase?: Phase
  readonly sla?: SlaConfig
  readonly input: (
    state: TState,
    ctx: FlowContext<TSteps>,
  ) => Effect.Effect<
    IssueAuthorisedSalesInvoiceInput,
    AuthorTaggedError,
    unknown
  >
}

/**
 * System step that issues one authorised Xero Sales Invoice.
 */
export class XeroInvoiceStep<
  TState = Record<string, never>,
  TSteps extends Record<string, StepMeta | FormStepMeta> = Record<
    string,
    never
  >,
  TId extends string = string,
> extends SystemStep<
  TState,
  TSteps,
  IssueAuthorisedSalesInvoiceInput,
  typeof xeroInvoiceOutput,
  TId
> {
  constructor(
    scope:
      | Process
      | IStepScope<TState, TSteps>
      | FlowPath<TState, Schema.Struct.Fields | undefined, TSteps>,
    id: TId,
    props: XeroInvoiceStepProps<TState, TSteps>,
  ) {
    super(scope, id, {
      ...props,
      output: xeroInvoiceOutput,
    })
  }

  execute(
    input: IssueAuthorisedSalesInvoiceInput,
  ): Effect.Effect<
    InferSchemaType<typeof xeroInvoiceOutput>,
    XeroInvoiceError,
    XeroInvoice | CurrentStepJobContext
  > {
    return Effect.gen(this, function* () {
      const decoded = yield* decodeIssueAuthorisedSalesInvoiceInput(input)
      const xero = yield* XeroInvoice
      return yield* xero.issueAuthorisedSalesInvoice(decoded)
    })
  }
}
