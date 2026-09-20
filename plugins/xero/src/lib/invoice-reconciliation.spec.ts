import { Schema } from "effect"
import { IssueAuthorisedSalesInvoiceInput } from "./identities"
import {
  isMateriallyCompatibleInvoice,
  parseXeroCalendarDate,
  wireAmountToMoney,
} from "./invoice-reconciliation"
import { describe, expect, it } from "bun:test"

const input = Schema.decodeUnknownSync(IssueAuthorisedSalesInvoiceInput)({
  customer: { name: "Ada Lovelace", email: "ada@example.com" },
  shippingAddress: { line1: "10 Customhouse Quay", city: "Wellington" },
  productSku: "TBS-100",
  agreedPrice: "100.00",
  currency: "NZD",
  reference: "ORD-1001",
  date: "2026-03-15",
  dueDate: "2026-03-15",
})

const compatible = {
  invoiceId: "00000000-0000-4000-8000-e00000000001",
  invoiceNumber: "INV-0001",
  type: "ACCREC",
  status: "AUTHORISED",
  currency: "NZD",
  date: "2026-03-15",
  dueDate: "2026-03-15",
  contactId: "00000000-0000-4000-8000-c00000000001",
  itemCode: "TBS-100",
  unitAmount: "100.00",
  total: "100.00",
  lineCount: 1,
}

describe("Sales Invoice material compatibility", () => {
  it("parses Xero Microsoft JSON dates and ISO calendar dates", () => {
    expect(parseXeroCalendarDate("2026-03-15")).toBe("2026-03-15")
    expect(parseXeroCalendarDate("2026-03-15T00:00:00")).toBe("2026-03-15")
    expect(parseXeroCalendarDate("/Date(1773532800000+0000)/")).toBe(
      "2026-03-15",
    )
    // 2026-03-15 00:00 Pacific/Auckland (UTC+13) as Xero Microsoft JSON.
    expect(parseXeroCalendarDate("/Date(1773486000000+1300)/")).toBe(
      "2026-03-15",
    )
  })

  it("normalizes provider amounts to exact money", () => {
    expect(wireAmountToMoney(100)).toBe("100.00")
    expect(wireAmountToMoney("100.00")).toBe("100.00")
    expect(wireAmountToMoney(13.04)).toBe("13.04")
  })

  it("accepts an authorised ACCREC invoice that matches contact, SKU, amount, currency, and dates", () => {
    expect(
      isMateriallyCompatibleInvoice(
        compatible,
        input,
        "00000000-0000-4000-8000-c00000000001",
      ),
    ).toBe(true)
    expect(
      isMateriallyCompatibleInvoice(
        {
          ...compatible,
          date: "/Date(1773486000000+1300)/",
          dueDate: "/Date(1773486000000+1300)/",
        },
        input,
        compatible.contactId,
      ),
    ).toBe(true)
  })

  it("rejects mismatches in the material comparison fields", () => {
    expect(
      isMateriallyCompatibleInvoice(
        { ...compatible, contactId: "00000000-0000-4000-8000-c00000000002" },
        input,
        "00000000-0000-4000-8000-c00000000001",
      ),
    ).toBe(false)
    expect(
      isMateriallyCompatibleInvoice(
        { ...compatible, itemCode: "OTHER" },
        input,
        compatible.contactId,
      ),
    ).toBe(false)
    expect(
      isMateriallyCompatibleInvoice(
        { ...compatible, unitAmount: "90.00", total: "90.00" },
        input,
        compatible.contactId,
      ),
    ).toBe(false)
    expect(
      isMateriallyCompatibleInvoice(
        { ...compatible, date: "2026-03-14", dueDate: "2026-03-14" },
        input,
        compatible.contactId,
      ),
    ).toBe(false)
    expect(
      isMateriallyCompatibleInvoice(
        { ...compatible, currency: "USD" },
        input,
        compatible.contactId,
      ),
    ).toBe(false)
    expect(
      isMateriallyCompatibleInvoice(
        { ...compatible, type: "ACCPAY" },
        input,
        compatible.contactId,
      ),
    ).toBe(false)
    expect(
      isMateriallyCompatibleInvoice(
        { ...compatible, status: "DRAFT" },
        input,
        compatible.contactId,
      ),
    ).toBe(false)
  })
})
