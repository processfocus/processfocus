import { Schema } from "effect"
import { invoiceLinesTotalCents } from "./money"

const GUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const EXACT_MONEY_PATTERN = /^(?:0|[1-9]\d*)\.\d{2}$/

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export const CustomerName = Schema.NonEmptyString.pipe(
  Schema.brand("CustomerName"),
)
export type CustomerName = typeof CustomerName.Type

export const EmailAddress = Schema.String.pipe(
  Schema.check(Schema.isPattern(EMAIL_PATTERN)),
  Schema.brand("EmailAddress"),
)
export type EmailAddress = typeof EmailAddress.Type

export const ProductSku = Schema.NonEmptyString.pipe(Schema.brand("ProductSku"))
export type ProductSku = typeof ProductSku.Type

export const InvoiceReference = Schema.NonEmptyString.pipe(
  Schema.brand("InvoiceReference"),
)
export type InvoiceReference = typeof InvoiceReference.Type

export const CurrencyCode = Schema.Literal("NZD")
export type CurrencyCode = typeof CurrencyCode.Type

export const CalendarDate = Schema.String.pipe(
  Schema.check(Schema.isPattern(CALENDAR_DATE_PATTERN)),
  Schema.brand("CalendarDate"),
)
export type CalendarDate = typeof CalendarDate.Type

export const XeroContactId = Schema.String.pipe(
  Schema.check(Schema.isPattern(GUID_PATTERN)),
  Schema.brand("XeroContactId"),
)
export type XeroContactId = typeof XeroContactId.Type

export const XeroInvoiceId = Schema.String.pipe(
  Schema.check(Schema.isPattern(GUID_PATTERN)),
  Schema.brand("XeroInvoiceId"),
)
export type XeroInvoiceId = typeof XeroInvoiceId.Type

export const XeroInvoiceNumber = Schema.NonEmptyString.pipe(
  Schema.brand("XeroInvoiceNumber"),
)
export type XeroInvoiceNumber = typeof XeroInvoiceNumber.Type

export const CustomerDetails = Schema.Struct({
  name: CustomerName,
  email: EmailAddress,
})
export type CustomerDetails = typeof CustomerDetails.Type

export const ShippingAddress = Schema.Struct({
  line1: Schema.NonEmptyString,
  line2: Schema.optional(Schema.NonEmptyString),
  city: Schema.NonEmptyString,
  region: Schema.optional(Schema.String),
  postalCode: Schema.optional(Schema.String),
  country: Schema.optional(Schema.String),
})
export type ShippingAddress = typeof ShippingAddress.Type

const SalesInvoiceFields = {
  customer: CustomerDetails,
  shippingAddress: ShippingAddress,
  currency: CurrencyCode,
  reference: InvoiceReference,
  // Lookup-only alias for invoices issued before a reference migration.
  legacyReference: Schema.optional(InvoiceReference),
  // Recover old executions whose customer-facing reference is unavailable.
  recoveryOnly: Schema.optional(Schema.Literal(true)),
  // Written only to Xero History & Notes, never to the invoice payload.
  internalNote: Schema.optional(
    Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(2500))),
  ),
  date: CalendarDate,
  dueDate: CalendarDate,
}

const UnitAmount = Schema.String.pipe(
  Schema.check(Schema.isPattern(EXACT_MONEY_PATTERN)),
  Schema.check(
    Schema.makeFilter(
      (amount) =>
        BigInt(amount.replace(".", "")) <= BigInt(Number.MAX_SAFE_INTEGER),
      { message: "Unit amount must be safe integer cents" },
    ),
  ),
)

const Quantity = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))

export const SalesInvoiceLine = Schema.Struct({
  productSku: ProductSku,
  quantity: Quantity,
  unitAmount: UnitAmount,
})
export type SalesInvoiceLine = typeof SalesInvoiceLine.Type

export const IssueAuthorisedSalesInvoiceInput = Schema.Struct({
  ...SalesInvoiceFields,
  lines: Schema.NonEmptyArray(SalesInvoiceLine),
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (input) =>
        invoiceLinesTotalCents(input.lines) <= BigInt(Number.MAX_SAFE_INTEGER),
      { message: "Invoice total must be safe integer cents" },
    ),
  ),
  Schema.check(
    Schema.makeFilter((input) => input.date === input.dueDate, {
      message:
        "DueDate must equal Date so the Sales Invoice is immediately due",
    }),
  ),
)
export type IssueAuthorisedSalesInvoiceInput =
  typeof IssueAuthorisedSalesInvoiceInput.Type

export const IssuedSalesInvoiceLine = Schema.Struct({
  itemCode: Schema.String,
  quantity: Quantity,
  unitAmount: UnitAmount,
  description: Schema.String,
})
export type IssuedSalesInvoiceLine = typeof IssuedSalesInvoiceLine.Type

export const IssuedSalesInvoice = Schema.Struct({
  invoiceId: XeroInvoiceId,
  invoiceNumber: XeroInvoiceNumber,
  // Description availability must not discard an already issued invoice.
  // Processes that require it for customer instructions validate before sending.
  productDescription: Schema.String,
  lines: Schema.Array(IssuedSalesInvoiceLine),
})
export type IssuedSalesInvoice = typeof IssuedSalesInvoice.Type

export const normalizeEmail = (email: string): string =>
  email.trim().toLowerCase()

export const isUniqueEmailMatch = (matchCount: number): boolean =>
  matchCount === 1
