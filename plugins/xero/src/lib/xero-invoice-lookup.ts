import { Context, type Effect, Schema } from "effect"
import type { XeroInvoiceError } from "./errors"
import { XeroContactId, XeroInvoiceId } from "./identities"

/** Read-only accounting identities for invoice planning, not contact creation. */
const InvoiceContact = Schema.Struct({
  contactId: XeroContactId,
  name: Schema.String,
  active: Schema.Boolean,
  emails: Schema.Array(Schema.String),
  invoiceRecipientEmails: Schema.Array(Schema.String),
})
const ExistingInvoice = Schema.Struct({
  invoiceId: XeroInvoiceId,
  invoiceNumber: Schema.String,
  contactId: XeroContactId,
  reference: Schema.String,
  status: Schema.String,
})
export const InvoiceDirectory = Schema.Struct({
  contacts: Schema.Array(InvoiceContact),
  invoices: Schema.Array(ExistingInvoice),
})
export type InvoiceDirectory = typeof InvoiceDirectory.Type

export class XeroInvoiceLookup extends Context.Tag(
  "@processfocus/plugin-xero/XeroInvoiceLookup",
)<
  XeroInvoiceLookup,
  {
    /** Includes all contacts and ACCREC invoices containing the reference text. */
    readonly readDirectory: (
      reference: string,
      previousReference?: string,
    ) => Effect.Effect<InvoiceDirectory, XeroInvoiceError>
  }
>() {}
