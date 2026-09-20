import { Either, Schema } from "effect"
import { ExactMoney, IssueAuthorisedSalesInvoiceInput } from "./identities"
import { describe, expect, it } from "bun:test"

const validInput = {
  customer: { name: "Ada Lovelace", email: "ada@example.com" },
  shippingAddress: {
    line1: "10 Customhouse Quay",
    city: "Wellington",
    postalCode: "6011",
    country: "New Zealand",
  },
  productSku: "TBS-100",
  agreedPrice: "100.00",
  currency: "NZD",
  reference: "ORD-1001",
  date: "2026-03-15",
  dueDate: "2026-03-15",
} as const

describe("Sales Invoice public input", () => {
  it("accepts validated identities, exact decimal money, and NZD", () => {
    const decoded = Schema.decodeUnknownSync(IssueAuthorisedSalesInvoiceInput)(
      validInput,
    )

    expect(`${decoded.agreedPrice}`).toBe("100.00")
    expect(decoded.currency).toBe("NZD")
    expect(`${decoded.productSku}`).toBe("TBS-100")
    expect(`${decoded.reference}`).toBe("ORD-1001")
  })

  it("rejects JavaScript-number money", () => {
    const result = Schema.decodeUnknownEither(IssueAuthorisedSalesInvoiceInput)(
      {
        ...validInput,
        agreedPrice: 100,
      },
    )

    expect(Either.isLeft(result)).toBe(true)
  })

  it("rejects money without two decimal places", () => {
    const result = Schema.decodeUnknownEither(ExactMoney)("100")
    expect(Either.isLeft(result)).toBe(true)
  })

  it("rejects a zero agreed price", () => {
    const result = Schema.decodeUnknownEither(ExactMoney)("0.00")
    expect(Either.isLeft(result)).toBe(true)
  })

  it("rejects a currency other than NZD", () => {
    const result = Schema.decodeUnknownEither(IssueAuthorisedSalesInvoiceInput)(
      {
        ...validInput,
        currency: "USD",
      },
    )

    expect(Either.isLeft(result)).toBe(true)
  })

  it("rejects a DueDate that is not immediately due", () => {
    const result = Schema.decodeUnknownEither(IssueAuthorisedSalesInvoiceInput)(
      {
        ...validInput,
        dueDate: "2026-03-16",
      },
    )

    expect(Either.isLeft(result)).toBe(true)
  })
})
