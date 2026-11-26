import { Context, type Effect, Schema } from "effect"
import type { XeroInvoiceError } from "./errors"
import { XeroInvoiceId, XeroInvoiceNumber } from "./identities"
import { SalesInvoiceProposal } from "./xero-invoice-preparation"

/** Explicit write intent: each invocation permits another draft of the reference. */
export const RepeatedDraftSalesInvoice = SalesInvoiceProposal.pipe(
  Schema.check(
    Schema.makeFilter((invoice) => {
      const amounts = invoice.lines.filter((line) => "itemCode" in line)
      return (
        invoice.expectedRecipientEmails.length > 0 &&
        invoice.dueDate >= invoice.date &&
        amounts.length > 0 &&
        amounts.every(
          (line) =>
            Number.isSafeInteger(line.quantity) &&
            line.quantity > 0 &&
            Number.isFinite(line.unitAmountCents) &&
            line.unitAmountCents >= 0 &&
            Number.isSafeInteger(line.lineAmountCents) &&
            line.lineAmountCents >= 0 &&
            Math.abs(
              line.quantity * line.unitAmountCents - line.lineAmountCents,
            ) <= 0.500001 &&
            Number.isSafeInteger(line.taxCents),
        ) &&
        amounts.reduce((sum, line) => sum + line.lineAmountCents, 0) ===
          invoice.totalCents &&
        amounts.reduce((sum, line) => sum + line.taxCents, 0) ===
          invoice.taxCents &&
        invoice.totalCents - invoice.taxCents === invoice.subtotalCents
      )
    }),
  ),
)
export type RepeatedDraftSalesInvoice = typeof RepeatedDraftSalesInvoice.Type
export const CreatedRepeatedDraft = Schema.Struct({
  kind: Schema.Literal("created-draft"),
  invoiceId: XeroInvoiceId,
  invoiceNumber: XeroInvoiceNumber,
  status: Schema.Literal("DRAFT"),
})
export type CreatedRepeatedDraft = typeof CreatedRepeatedDraft.Type

export class XeroRepeatedDraftInvoice extends Context.Service<
  XeroRepeatedDraftInvoice,
  {
    readonly create: (
      invoice: RepeatedDraftSalesInvoice,
    ) => Effect.Effect<CreatedRepeatedDraft, XeroInvoiceError>
  }
>()("@processfocus/plugin-xero/XeroRepeatedDraftInvoice") {}
