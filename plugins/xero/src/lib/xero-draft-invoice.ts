import { Context, type Effect, Schema } from "effect"
import type { XeroInvoiceError } from "./errors"
import {
  CalendarDate,
  EmailAddress,
  XeroContactId,
  XeroInvoiceId,
  XeroInvoiceNumber,
} from "./identities"

const cents = Schema.Number.pipe(Schema.filter(Number.isSafeInteger))
const nonBlank = Schema.Trim.pipe(Schema.minLength(1))
const Tracking = Schema.Array(
  Schema.Struct({
    category: nonBlank,
    option: nonBlank,
  }),
).pipe(
  Schema.minItems(1),
  Schema.filter(
    (tracking) =>
      new Set(tracking.map((entry) => entry.category.toLowerCase())).size ===
      tracking.length,
  ),
)

export const DraftSalesInvoice = Schema.Struct({
  contactId: XeroContactId,
  reference: nonBlank,
  // Stable duplicate-check/idempotency scope when the display adds a suffix.
  duplicateReference: Schema.optional(nonBlank),
  type: Schema.Literal("ACCREC"),
  status: Schema.Literal("DRAFT"),
  date: CalendarDate,
  dueDate: CalendarDate,
  currency: Schema.Literal("NZD"),
  lineAmountType: Schema.Literal("Inclusive"),
  lines: Schema.Array(
    Schema.Struct({
      itemCode: nonBlank,
      description: nonBlank,
      quantity: Schema.Int.pipe(Schema.positive()),
      unitAmountCents: cents,
      lineAmountCents: cents,
      taxCents: cents,
      taxType: nonBlank,
      // Xero resolves these category and option names to its tenant-owned IDs.
      // Keeping names in the authoring contract avoids leaking a tenant's IDs.
      tracking: Schema.optional(Tracking),
    }),
  ).pipe(Schema.minItems(1)),
  totalCents: cents.pipe(Schema.nonNegative()),
  taxCents: cents,
  subtotalCents: cents,
  // Older saved previews did not capture recipient intent. They remain readable,
  // but a new write requires this field and rechecks the live contact.
  expectedRecipientEmails: Schema.optional(
    Schema.Array(Schema.Trim.pipe(Schema.filter(Schema.is(EmailAddress)))).pipe(
      Schema.minItems(1),
    ),
  ),
}).pipe(
  Schema.filter(
    (invoice) =>
      invoice.dueDate >= invoice.date &&
      (invoice.duplicateReference === undefined ||
        matchesInvoiceReference(
          invoice.reference,
          invoice.duplicateReference,
        )) &&
      invoice.lines.every(
        (line) => line.quantity * line.unitAmountCents === line.lineAmountCents,
      ) &&
      invoice.lines.reduce((sum, line) => sum + line.lineAmountCents, 0) ===
        invoice.totalCents &&
      invoice.lines.reduce((sum, line) => sum + line.taxCents, 0) ===
        invoice.taxCents &&
      invoice.totalCents - invoice.taxCents === invoice.subtotalCents,
  ),
)
export type DraftSalesInvoice = typeof DraftSalesInvoice.Type

export const DraftInvoiceResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("created-draft"),
    invoiceId: XeroInvoiceId,
    invoiceNumber: XeroInvoiceNumber,
    status: Schema.Literal("DRAFT"),
  }),
  Schema.Struct({
    kind: Schema.Literal("skipped-existing"),
    existingInvoices: Schema.NonEmptyArray(
      Schema.Struct({
        invoiceId: XeroInvoiceId,
        invoiceNumber: XeroInvoiceNumber,
        status: Schema.String,
      }),
    ),
  }),
)
export type DraftInvoiceResult = typeof DraftInvoiceResult.Type

export const matchesInvoiceReference = (
  actual: string,
  reference: string,
): boolean => {
  const normalize = (value: string) =>
    value.trim().replace(/\s+/g, " ").toUpperCase()
  const candidate = normalize(actual)
  const expected = normalize(reference)
  return candidate === expected || candidate.startsWith(`${expected} `)
}

/** Creates drafts only, for an already resolved contact; never updates contacts. */
export class XeroDraftInvoice extends Context.Tag(
  "@processfocus/plugin-xero/XeroDraftInvoice",
)<
  XeroDraftInvoice,
  {
    readonly createIfAbsent: (
      invoice: DraftSalesInvoice,
    ) => Effect.Effect<DraftInvoiceResult, XeroInvoiceError>
  }
>() {}
