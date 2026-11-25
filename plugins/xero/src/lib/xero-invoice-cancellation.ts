import { Context, Effect, Schema } from "effect"
import { type XeroInvoiceError, xeroValidationError } from "./errors"
import { XeroInvoiceId, XeroInvoiceNumber } from "./identities"

export const CancelSalesInvoiceInput = Schema.Struct({
  invoiceId: XeroInvoiceId,
})
export type CancelSalesInvoiceInput = typeof CancelSalesInvoiceInput.Type

export const CancelledSalesInvoice = Schema.Struct({
  invoiceId: XeroInvoiceId,
  invoiceNumber: XeroInvoiceNumber,
  status: Schema.Literal("VOIDED"),
})
export type CancelledSalesInvoice = typeof CancelledSalesInvoice.Type

export const decodeCancelSalesInvoiceInput = (
  input: unknown,
): Effect.Effect<CancelSalesInvoiceInput, XeroInvoiceError> =>
  Schema.decodeUnknownEffect(CancelSalesInvoiceInput)(input).pipe(
    Effect.mapError(() =>
      xeroValidationError("A valid Xero invoice ID is required"),
    ),
  )

export class XeroInvoiceCancellation extends Context.Service<
  XeroInvoiceCancellation,
  {
    readonly cancel: (
      input: CancelSalesInvoiceInput,
    ) => Effect.Effect<CancelledSalesInvoice, XeroInvoiceError>
  }
>()("@processfocus/plugin-xero/XeroInvoiceCancellation") {}
