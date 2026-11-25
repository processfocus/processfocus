import { Effect, type Schema } from "effect"
import {
  type AuthorTaggedError,
  type FlowContext,
  type FlowPath,
  type FormStepMeta,
  type IStepScope,
  type Phase,
  type Process,
  type SlaConfig,
  type StepMeta,
  SystemStep,
} from "@pf/process"
import type { XeroInvoiceError } from "./errors"
import {
  type CancelSalesInvoiceInput,
  CancelledSalesInvoice,
  XeroInvoiceCancellation,
  decodeCancelSalesInvoiceInput,
} from "./xero-invoice-cancellation"

export type XeroInvoiceCancellationStepProps<
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
  ) => Effect.Effect<CancelSalesInvoiceInput, AuthorTaggedError, unknown>
}

/** Cancels the stored Sales Invoice; the process owns the cancellation decision. */
export class XeroInvoiceCancellationStep<
  TState = Record<string, never>,
  TSteps extends Record<string, StepMeta | FormStepMeta> = Record<
    string,
    never
  >,
  TId extends string = string,
> extends SystemStep<
  TState,
  TSteps,
  CancelSalesInvoiceInput,
  typeof CancelledSalesInvoice.fields,
  TId
> {
  constructor(
    scope:
      | Process
      | IStepScope<TState, TSteps>
      | FlowPath<TState, Schema.Struct.Fields | undefined, TSteps>,
    id: TId,
    props: XeroInvoiceCancellationStepProps<TState, TSteps>,
  ) {
    super(scope, id, { ...props, output: CancelledSalesInvoice.fields })
  }

  execute(
    input: CancelSalesInvoiceInput,
  ): Effect.Effect<
    CancelledSalesInvoice,
    XeroInvoiceError,
    XeroInvoiceCancellation
  > {
    return Effect.gen(function* () {
      const decoded = yield* decodeCancelSalesInvoiceInput(input)
      const xero = yield* XeroInvoiceCancellation
      return yield* xero.cancel(decoded)
    })
  }
}
