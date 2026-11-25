import { Context, type Effect, Schema } from "effect"
import type { XeroInvoiceError } from "./errors"
import { CalendarDate, EmailAddress, XeroContactId } from "./identities"
import type { InvoiceDirectory } from "./xero-invoice-lookup"

/** Captured current sales values; unusable items remain explicit validation work. */
export const SalesItemResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("available"),
    code: Schema.String,
    description: Schema.String,
    unitAmountCents: Schema.Number,
  }),
  Schema.Struct({
    kind: Schema.Literal("invalid"),
    code: Schema.String,
    problem: Schema.String,
  }),
])
export type SalesItemResult = typeof SalesItemResult.Type

/** Read-only proposal contract, deliberately independent of createIfAbsent. */
export const SalesInvoiceProposal = Schema.Struct({
  contactId: XeroContactId,
  expectedRecipientEmails: Schema.Array(EmailAddress),
  reference: Schema.String,
  type: Schema.Literal("ACCREC"),
  status: Schema.Literal("DRAFT"),
  date: CalendarDate,
  dueDate: CalendarDate,
  currency: Schema.Literal("NZD"),
  lineAmountType: Schema.Literal("Inclusive"),
  lines: Schema.Array(
    Schema.Union([
      Schema.Struct({
        itemCode: Schema.String,
        description: Schema.String,
        quantity: Schema.Number,
        unitAmountCents: Schema.Number,
        lineAmountCents: Schema.Number,
        taxCents: Schema.Number,
        accountCode: Schema.String,
        taxType: Schema.String,
      }),
      Schema.Struct({ description: Schema.String }),
    ]),
  ),
  totalCents: Schema.Number,
  taxCents: Schema.Number,
  subtotalCents: Schema.Number,
})
export type SalesInvoiceProposal = typeof SalesInvoiceProposal.Type

export class XeroInvoicePreparation extends Context.Service<
  XeroInvoicePreparation,
  {
    readonly read: (codes: readonly string[]) => Effect.Effect<
      {
        readonly contacts: InvoiceDirectory["contacts"]
        readonly items: readonly SalesItemResult[]
      },
      XeroInvoiceError
    >
  }
>()("@processfocus/plugin-xero/XeroInvoicePreparation") {}
