import { Schema } from "effect"

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
  Schema.pattern(EMAIL_PATTERN),
  Schema.brand("EmailAddress"),
)
export type EmailAddress = typeof EmailAddress.Type

export const ProductSku = Schema.NonEmptyString.pipe(Schema.brand("ProductSku"))
export type ProductSku = typeof ProductSku.Type

export const InvoiceReference = Schema.NonEmptyString.pipe(
  Schema.brand("InvoiceReference"),
)
export type InvoiceReference = typeof InvoiceReference.Type

export const ExactMoney = Schema.String.pipe(
  Schema.pattern(EXACT_MONEY_PATTERN),
  Schema.filter((value) => value !== "0.00", {
    message: () => "Agreed Price must be greater than 0.00",
  }),
  Schema.brand("ExactMoney"),
)
export type ExactMoney = typeof ExactMoney.Type

export const CurrencyCode = Schema.Literal("NZD")
export type CurrencyCode = typeof CurrencyCode.Type

export const CalendarDate = Schema.String.pipe(
  Schema.pattern(CALENDAR_DATE_PATTERN),
  Schema.brand("CalendarDate"),
)
export type CalendarDate = typeof CalendarDate.Type

export const XeroContactId = Schema.String.pipe(
  Schema.pattern(GUID_PATTERN),
  Schema.brand("XeroContactId"),
)
export type XeroContactId = typeof XeroContactId.Type

export const XeroInvoiceId = Schema.String.pipe(
  Schema.pattern(GUID_PATTERN),
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

export const IssueAuthorisedSalesInvoiceInput = Schema.Struct({
  customer: CustomerDetails,
  shippingAddress: ShippingAddress,
  productSku: ProductSku,
  agreedPrice: ExactMoney,
  currency: CurrencyCode,
  reference: InvoiceReference,
  date: CalendarDate,
  dueDate: CalendarDate,
}).pipe(
  Schema.filter((input) => input.date === input.dueDate, {
    message: () =>
      "DueDate must equal Date so the Sales Invoice is immediately due",
  }),
)
export type IssueAuthorisedSalesInvoiceInput =
  typeof IssueAuthorisedSalesInvoiceInput.Type

export const IssuedSalesInvoice = Schema.Struct({
  invoiceId: XeroInvoiceId,
  invoiceNumber: XeroInvoiceNumber,
})
export type IssuedSalesInvoice = typeof IssuedSalesInvoice.Type

export const normalizeEmail = (email: string): string =>
  email.trim().toLowerCase()

export const isUniqueEmailMatch = (matchCount: number): boolean =>
  matchCount === 1
