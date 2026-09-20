import {
  CONFORMANCE_AGREED_PRICE,
  CONFORMANCE_GST_TAX,
  CONFORMANCE_SHIPPING_LINE1,
  CONFORMANCE_ZERO_TAX,
  catalogItemCodes,
} from "./catalog"
import { containsProhibitedDiagnostics, evidenceJson } from "./evidence"
import {
  type SharedScenarioResults,
  authorisedInclusiveMatches,
} from "./scenarios"
import { expect } from "bun:test"

export const expectSharedScenarioResults = (
  results: SharedScenarioResults,
  requestedUrls: readonly string[],
): void => {
  const items = catalogItemCodes()

  expect(
    authorisedInclusiveMatches(results.zeroTax.invoice, {
      itemCode: items.zeroTax,
      totalTax: CONFORMANCE_ZERO_TAX,
    }),
  ).toBe(true)
  expect(results.zeroTax.invoice.total).toBe(CONFORMANCE_AGREED_PRICE)
  expect(results.zeroTax.invoiceNumber.length).toBeGreaterThan(0)
  const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  expect(results.zeroTax.invoiceId).toMatch(guid)
  expect(results.zeroTax.invoice.contactId).toMatch(guid)

  expect(`${results.replay.invoiceId}`).toBe(`${results.zeroTax.invoiceId}`)
  expect(`${results.replay.invoiceNumber}`).toBe(
    `${results.zeroTax.invoiceNumber}`,
  )

  expect(results.resolved.invoice.contactId).toMatch(guid)
  expect(results.resolved.invoice.contactId).toBe(
    results.zeroTax.invoice.contactId,
  )
  expect(`${results.resolved.invoiceId}`).not.toBe(
    `${results.zeroTax.invoiceId}`,
  )
  expect(
    authorisedInclusiveMatches(results.resolved.invoice, {
      itemCode: items.zeroTax,
      totalTax: CONFORMANCE_ZERO_TAX,
    }),
  ).toBe(true)

  expect(
    authorisedInclusiveMatches(results.gst.invoice, {
      itemCode: items.gst,
      totalTax: CONFORMANCE_GST_TAX,
    }),
  ).toBe(true)
  expect(results.gst.invoice.total).toBe(CONFORMANCE_AGREED_PRICE)
  expect(results.gst.invoice.contactId).toMatch(guid)
  expect(results.gst.invoice.contactId).not.toBe(
    results.zeroTax.invoice.contactId,
  )

  expect(results.unknownItem.code).toBe("unknown_item_code")
  expect(results.unknownItem.retryable).toBe(false)
  expect(results.unknownItem.fields).toEqual(["ItemCode"])

  expect(requestedUrls.some((url) => url.includes("/Email"))).toBe(false)

  const evidence = evidenceJson({
    zeroTax: results.zeroTax,
    resolved: results.resolved,
    gst: results.gst,
    replay: results.replay,
    unknownItem: results.unknownItem,
  })
  expect(containsProhibitedDiagnostics(evidence)).toBe(false)
  expect(evidence).not.toContain(CONFORMANCE_SHIPPING_LINE1)
  expect(evidence).not.toContain("Bearer ")
}
