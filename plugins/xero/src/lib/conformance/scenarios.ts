import { Effect, Schema } from "effect"
import {
  type IssueAuthorisedSalesInvoiceInput,
  IssueAuthorisedSalesInvoiceInput as IssueAuthorisedSalesInvoiceInputSchema,
} from "../identities"
import type { XeroInvoiceError } from "../xero-invoice"
import {
  CONFORMANCE_AGREED_PRICE,
  CONFORMANCE_CURRENCY,
  CONFORMANCE_SHIPPING_LINE1,
  catalogItemCodes,
} from "./catalog"
import {
  type ConformanceRun,
  uniqueCustomerEmail,
  uniqueCustomerName,
  uniqueOrderNumberReference,
  uniqueTodoId,
} from "./run-id"

export interface ObservableInvoice {
  readonly type: string
  readonly status: string
  readonly currency: string
  readonly reference: string
  readonly total: string
  readonly totalTax: string
  readonly itemCode: string
  readonly quantity: string
  readonly unitAmount: string
  readonly lineCount: number
  readonly contactId: string
  readonly date: string
  readonly dueDate: string
}

interface IssuedObservation {
  readonly invoiceId: string
  readonly invoiceNumber: string
  readonly invoice: ObservableInvoice
}

interface FailedObservation {
  readonly code: string
  readonly retryable: boolean
  readonly fields: readonly string[]
  readonly message: string
}

export type ScenarioObservation =
  | { readonly kind: "issued"; readonly issued: IssuedObservation }
  | { readonly kind: "failed"; readonly failed: FailedObservation }

export interface ConformanceHarness {
  readonly kind: "test" | "live"
  readonly prepare: () => Effect.Effect<void, XeroInvoiceError>
  readonly issue: (
    input: IssueAuthorisedSalesInvoiceInput,
    todoId: string,
  ) => Effect.Effect<ScenarioObservation, XeroInvoiceError>
  readonly invoiceCountByReference: (
    reference: string,
  ) => Effect.Effect<number, XeroInvoiceError>
  readonly requestedUrls: () => readonly string[]
}

const scenarioInput = ({
  run,
  customerName,
  email,
  productSku,
  scenario,
}: {
  readonly run: ConformanceRun
  readonly customerName: string
  readonly email: string
  readonly productSku: string
  readonly scenario: string
}): IssueAuthorisedSalesInvoiceInput =>
  Schema.decodeUnknownSync(IssueAuthorisedSalesInvoiceInputSchema)({
    customer: { name: customerName, email },
    shippingAddress: {
      line1: CONFORMANCE_SHIPPING_LINE1,
      city: "Wellington",
      postalCode: "6011",
      country: "New Zealand",
    },
    productSku,
    agreedPrice: CONFORMANCE_AGREED_PRICE,
    currency: CONFORMANCE_CURRENCY,
    reference: uniqueOrderNumberReference(run, scenario),
    date: run.date,
    dueDate: run.date,
  })

const requireIssued = (observation: ScenarioObservation): IssuedObservation => {
  if (observation.kind !== "issued") {
    throw new Error(
      `expected issued Sales Invoice, got ${observation.failed.code}: ${observation.failed.message}`,
    )
  }
  return observation.issued
}

const requireFailed = (observation: ScenarioObservation): FailedObservation => {
  if (observation.kind !== "failed") {
    throw new Error(
      `expected XeroInvoiceError, got invoice ${observation.issued.invoiceNumber}`,
    )
  }
  return observation.failed
}

const isAuthorisedAccrec = (invoice: ObservableInvoice): boolean =>
  invoice.type === "ACCREC" &&
  invoice.status === "AUTHORISED" &&
  invoice.currency === CONFORMANCE_CURRENCY &&
  invoice.total === CONFORMANCE_AGREED_PRICE &&
  invoice.unitAmount === CONFORMANCE_AGREED_PRICE &&
  invoice.quantity === "1" &&
  invoice.lineCount === 1

export const authorisedInclusiveMatches = (
  invoice: ObservableInvoice,
  expected: { readonly itemCode: string; readonly totalTax: string },
): boolean =>
  isAuthorisedAccrec(invoice) &&
  invoice.itemCode === expected.itemCode &&
  invoice.totalTax === expected.totalTax

export interface SharedScenarioResults {
  readonly zeroTax: IssuedObservation
  readonly resolved: IssuedObservation
  readonly gst: IssuedObservation
  readonly replay: IssuedObservation
  readonly unknownItem: FailedObservation
}

export const runSharedConformanceScenarios = (
  harness: ConformanceHarness,
  run: ConformanceRun,
): Effect.Effect<SharedScenarioResults, XeroInvoiceError> =>
  Effect.gen(function* () {
    const items = catalogItemCodes()
    yield* harness.prepare()

    const createName = uniqueCustomerName(run, "Zero")
    const createEmail = uniqueCustomerEmail(run, "Zero")
    const zeroInput = scenarioInput({
      run,
      customerName: createName,
      email: createEmail,
      productSku: items.zeroTax,
      scenario: "ZT",
    })
    const zeroTodo = uniqueTodoId(run, "zt")
    const zeroTax = requireIssued(yield* harness.issue(zeroInput, zeroTodo))
    const replay = requireIssued(yield* harness.issue(zeroInput, zeroTodo))

    const resolveInput = scenarioInput({
      run,
      customerName: createName,
      email: createEmail,
      productSku: items.zeroTax,
      scenario: "RS",
    })
    const resolved = requireIssued(
      yield* harness.issue(resolveInput, uniqueTodoId(run, "rs")),
    )

    const gstInput = scenarioInput({
      run,
      customerName: uniqueCustomerName(run, "Gst"),
      email: uniqueCustomerEmail(run, "Gst"),
      productSku: items.gst,
      scenario: "GST",
    })
    const gst = requireIssued(
      yield* harness.issue(gstInput, uniqueTodoId(run, "gst")),
    )

    const unknownInput = scenarioInput({
      run,
      customerName: uniqueCustomerName(run, "Unknown"),
      email: uniqueCustomerEmail(run, "Unknown"),
      productSku: `PF-UNKNOWN-${run.id}`,
      scenario: "UNK",
    })
    const unknownItem = requireFailed(
      yield* harness.issue(unknownInput, uniqueTodoId(run, "unk")),
    )

    return { zeroTax, resolved, gst, replay, unknownItem }
  })
