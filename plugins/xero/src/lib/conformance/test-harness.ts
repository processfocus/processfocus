import { Effect, Either } from "effect"
import { CurrentStepJobContext } from "@pf/process"
import { parseXeroCalendarDate } from "../invoice-reconciliation"
import { XeroInvoice } from "../xero-invoice"
import { makeXeroInvoiceTestPlugin } from "../xero-invoice-test"
import { catalogItemCodes } from "./catalog"
import type {
  ConformanceHarness,
  ObservableInvoice,
  ScenarioObservation,
} from "./scenarios"

const normalizeQuantity = (value: string): string =>
  value === "1.00" ? "1" : value

export const makeTestConformanceHarness = (): ConformanceHarness => {
  const plugin = makeXeroInvoiceTestPlugin()
  const items = catalogItemCodes()

  return {
    kind: "test",
    prepare: () =>
      Effect.sync(() => {
        plugin.controller.clear()
        plugin.controller.seedItem({
          itemCode: items.zeroTax,
          name: "PF Conformance Zero Tax",
          taxType: "NONE",
          taxPercent: 0,
        })
        plugin.controller.seedItem({
          itemCode: items.gst,
          name: "PF Conformance GST 15",
          taxType: "OUTPUT",
          taxPercent: 15,
        })
      }),
    issue: (input, todoId) =>
      Effect.gen(function* () {
        const result = yield* Effect.gen(function* () {
          const xero = yield* XeroInvoice
          return yield* xero.issueAuthorisedSalesInvoice(input)
        }).pipe(
          Effect.provide(plugin.layer),
          Effect.provideService(CurrentStepJobContext, {
            todoId,
            stepPath: "/Create Xero Invoice",
          }),
          Effect.either,
        )
        return Either.match(result, {
          onLeft: (error): ScenarioObservation => ({
            kind: "failed",
            failed: {
              code: error.code ?? "unknown",
              retryable: error.retryable,
              fields: error.fields ?? [],
              message: error.message,
            },
          }),
          onRight: (issued): ScenarioObservation => {
            const stored = plugin.controller.findInvoiceByReference(
              input.reference,
            )
            const invoice = stored[0]
            if (stored.length !== 1 || invoice === undefined) {
              return {
                kind: "failed",
                failed: {
                  code: "malformed_response",
                  retryable: false,
                  fields: [],
                  message:
                    "Test adapter did not store exactly one Sales Invoice",
                },
              }
            }
            const observed: ObservableInvoice = {
              type: invoice.type,
              status: invoice.status,
              currency: invoice.currency,
              reference: invoice.reference,
              total: invoice.total,
              totalTax: invoice.totalTax,
              itemCode: invoice.lines[0]?.itemCode ?? "",
              quantity: normalizeQuantity(invoice.lines[0]?.quantity ?? ""),
              unitAmount: invoice.lines[0]?.unitAmount ?? "",
              lineCount: invoice.lines.length,
              contactId: invoice.contactId,
              date: parseXeroCalendarDate(String(invoice.date)) ?? "",
              dueDate: parseXeroCalendarDate(String(invoice.dueDate)) ?? "",
            }
            return {
              kind: "issued",
              issued: {
                invoiceId: `${issued.invoiceId}`,
                invoiceNumber: `${issued.invoiceNumber}`,
                invoice: observed,
              },
            }
          },
        })
      }),
    invoiceCountByReference: (reference) =>
      Effect.sync(
        () => plugin.controller.findInvoiceByReference(reference).length,
      ),
    requestedUrls: () => [],
  }
}
