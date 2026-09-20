import { Effect, Schema } from "effect"
import {
  type XeroInvoiceError,
  xeroAmbiguousReferenceError,
  xeroInvoiceIntentConflictError,
  xeroMalformedResponseError,
} from "./errors"
import {
  type IssueAuthorisedSalesInvoiceInput,
  type IssuedSalesInvoice,
  IssuedSalesInvoice as IssuedSalesInvoiceSchema,
} from "./identities"
import { centsToMoney } from "./money"

export interface ReconcilableInvoice {
  readonly invoiceId: string
  readonly invoiceNumber: string
  readonly type: string
  readonly status: string
  readonly currency: string
  readonly date: string
  readonly dueDate: string
  readonly contactId: string
  readonly itemCode: string
  readonly unitAmount: string
  readonly total: string
  readonly lineCount: number
}

const MICROSOFT_JSON_DATE = /\/Date\((\d+)(?:([+-])(\d{2})(\d{2}))?\)\//

/**
 * Xero date-only fields often serialise as a UTC instant of organisation-local
 * midnight plus an offset such as +1300. The calendar date is the local day,
 * not the UTC day of that instant.
 */
export const parseXeroCalendarDate = (value: string): string | undefined => {
  const microsoft = MICROSOFT_JSON_DATE.exec(value)
  if (microsoft?.[1] !== undefined) {
    const ticks = Number(microsoft[1])
    const sign = microsoft[2] === "-" ? -1 : 1
    const offsetHours = Number(microsoft[3] ?? "0")
    const offsetMinutes = Number(microsoft[4] ?? "0")
    const offsetMs = sign * (offsetHours * 60 + offsetMinutes) * 60 * 1000
    return new Date(ticks + offsetMs).toISOString().slice(0, 10)
  }
  const isoDate = /^(\d{4}-\d{2}-\d{2})/.exec(value)
  return isoDate?.[1]
}

export const wireAmountToMoney = (
  value: number | string | undefined,
): string | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return centsToMoney(Math.round(value * 100))
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) {
      return undefined
    }
    return centsToMoney(Math.round(parsed * 100))
  }
  return undefined
}

export const isMateriallyCompatibleInvoice = (
  invoice: ReconcilableInvoice,
  input: IssueAuthorisedSalesInvoiceInput,
  contactId: string,
): boolean =>
  invoice.contactId === contactId &&
  invoice.type === "ACCREC" &&
  invoice.status === "AUTHORISED" &&
  invoice.currency === input.currency &&
  parseXeroCalendarDate(invoice.date) === input.date &&
  parseXeroCalendarDate(invoice.dueDate) === input.dueDate &&
  invoice.lineCount === 1 &&
  invoice.itemCode === input.productSku &&
  invoice.unitAmount === input.agreedPrice &&
  invoice.total === input.agreedPrice

export const decodeIssuedSalesInvoice = (
  invoiceId: string,
  invoiceNumber: string,
): Effect.Effect<IssuedSalesInvoice, XeroInvoiceError> =>
  Schema.decodeUnknown(IssuedSalesInvoiceSchema)({
    invoiceId,
    invoiceNumber,
  }).pipe(
    Effect.mapError(() =>
      xeroMalformedResponseError("Malformed Xero invoice response"),
    ),
  )

/**
 * Reconcile invoices that already share this Order Number Reference.
 *
 * Zero matches means create. Exactly one materially compatible invoice is
 * success. Multiple invoices, or one with conflicting intent, fail without
 * changing the existing authorised invoice.
 */
export const reconcileExistingInvoices = (
  invoices: readonly ReconcilableInvoice[],
  input: IssueAuthorisedSalesInvoiceInput,
  contactId: string,
): Effect.Effect<IssuedSalesInvoice | undefined, XeroInvoiceError> => {
  if (invoices.length === 0) {
    return Effect.succeed(undefined)
  }
  if (invoices.length > 1) {
    return Effect.fail(xeroAmbiguousReferenceError(input.reference))
  }

  const invoice = invoices[0]
  if (
    invoice === undefined ||
    !isMateriallyCompatibleInvoice(invoice, input, contactId)
  ) {
    return Effect.fail(xeroInvoiceIntentConflictError(input.reference))
  }

  return decodeIssuedSalesInvoice(invoice.invoiceId, invoice.invoiceNumber)
}
