import { CONFORMANCE_SHIPPING_LINE1, catalogItemCodes } from "./catalog"
import {
  containsProhibitedDiagnostics,
  evidenceJson,
  sanitizeEvidence,
} from "./evidence"
import { createConformanceRun, uniqueOrderNumberReference } from "./run-id"
import { describe, expect, it } from "bun:test"

describe("conformance evidence sanitization", () => {
  it("omits Shipping Address, tokens, and credentials from captured fixtures", () => {
    const sanitized = sanitizeEvidence({
      reference: "PF123ZT",
      invoiceId: "22222222-2222-4222-8222-222222222222",
      shippingAddress: {
        line1: CONFORMANCE_SHIPPING_LINE1,
        city: "Wellington",
      },
      Addresses: [{ AddressLine1: CONFORMANCE_SHIPPING_LINE1 }],
      authorization: "Bearer xero-access-token",
      client_secret: "xero-client-secret",
      access_token: "xero-access-token",
      customerEmail: "pf-canary@example.com",
    })

    const json = evidenceJson(sanitized)
    expect(json).toContain("PF123ZT")
    expect(json).toContain("pf-canary@example.com")
    expect(json).not.toContain("shippingAddress")
    expect(json).not.toContain("Addresses")
    expect(json).not.toContain("authorization")
    expect(json).not.toContain("client_secret")
    expect(json).not.toContain("access_token")
    expect(containsProhibitedDiagnostics(json)).toBe(false)
    expect(json).not.toContain(CONFORMANCE_SHIPPING_LINE1)
    expect(json).not.toContain("Bearer ")
    expect(json).not.toContain("xero-client-secret")
  })

  it("defaults to the documented Demo Company catalog ItemCodes", () => {
    const previousZero = process.env["XERO_DEMO_ZERO_ITEM"]
    const previousGst = process.env["XERO_DEMO_GST_ITEM"]
    delete process.env["XERO_DEMO_ZERO_ITEM"]
    delete process.env["XERO_DEMO_GST_ITEM"]
    try {
      expect(catalogItemCodes()).toEqual({
        zeroTax: "PF-ZERO",
        gst: "PF-GST15",
      })
    } finally {
      if (previousZero === undefined) {
        delete process.env["XERO_DEMO_ZERO_ITEM"]
      } else {
        process.env["XERO_DEMO_ZERO_ITEM"] = previousZero
      }
      if (previousGst === undefined) {
        delete process.env["XERO_DEMO_GST_ITEM"]
      } else {
        process.env["XERO_DEMO_GST_ITEM"] = previousGst
      }
    }
  })

  it("creates unique Order Number References per canary run", () => {
    const first = createConformanceRun(1_700_000_000_000, () => "aaaaaaaa")
    const second = createConformanceRun(1_700_000_000_001, () => "bbbbbbbb")

    expect(uniqueOrderNumberReference(first, "ZT")).not.toBe(
      uniqueOrderNumberReference(second, "ZT"),
    )
    expect(uniqueOrderNumberReference(first, "ZT")).not.toBe(
      uniqueOrderNumberReference(first, "GST"),
    )
    expect(uniqueOrderNumberReference(first, "ZT").startsWith("PF")).toBe(true)
  })
})
