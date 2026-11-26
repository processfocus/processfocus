import { Exit, Schema } from "effect"
import { IssueAuthorisedSalesInvoiceInput } from "./identities"
import { describe, expect, it } from "bun:test"

const validInput = {
  customer: { name: "Ada Lovelace", email: "ada@example.com" },
  shippingAddress: {
    line1: "10 Customhouse Quay",
    city: "Wellington",
    postalCode: "6011",
    country: "New Zealand",
  },
  lines: [{ productSku: "TBS-100", quantity: 1, unitAmount: "100.00" }],
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

    expect(decoded).toMatchObject({ lines: validInput.lines })
    expect(decoded.currency).toBe("NZD")
    expect(`${decoded.reference}`).toBe("ORD-1001")
  })

  it("accepts non-empty lines with positive integer quantities and exact non-negative unit prices", () => {
    const lines = [
      { productSku: "TBS-100", quantity: 3, unitAmount: "100.00" },
      { productSku: "TBS-200", quantity: 1, unitAmount: "0.00" },
    ]
    const decoded = Schema.decodeUnknownSync(IssueAuthorisedSalesInvoiceInput)({
      ...validInput,
      lines,
    })
    expect(decoded).toMatchObject({ lines })
  })

  it.each(
    [
      undefined,
      [],
      [{ productSku: "TBS-100", quantity: 0, unitAmount: "1.00" }],
      [{ productSku: "TBS-100", quantity: -1, unitAmount: "1.00" }],
      [{ productSku: "TBS-100", quantity: 1.5, unitAmount: "1.00" }],
      [
        {
          productSku: "TBS-100",
          quantity: Number.MAX_SAFE_INTEGER + 1,
          unitAmount: "0.00",
        },
      ],
      [{ productSku: "TBS-100", quantity: 1, unitAmount: 1 }],
      [{ productSku: "TBS-100", quantity: 1, unitAmount: "100" }],
      [{ productSku: "TBS-100", quantity: 1, unitAmount: "1.001" }],
      [{ productSku: "TBS-100", quantity: 1, unitAmount: "-1.00" }],
      [{ productSku: "TBS-100", quantity: 1, unitAmount: "90071992547409.92" }],
      [{ productSku: "TBS-100", quantity: 2, unitAmount: "90071992547409.91" }],
      [
        { productSku: "TBS-100", quantity: 1, unitAmount: "90071992547409.91" },
        { productSku: "TBS-200", quantity: 1, unitAmount: "0.01" },
      ],
    ].map((lines) => ({ lines })),
  )("rejects invalid or unsafe lines (%j)", ({ lines }) => {
    expect(
      Exit.isFailure(
        Schema.decodeUnknownExit(IssueAuthorisedSalesInvoiceInput)({
          ...validInput,
          lines,
        }),
      ),
    ).toBe(true)
  })

  it("rejects a currency other than NZD", () => {
    const result = Schema.decodeUnknownExit(IssueAuthorisedSalesInvoiceInput)({
      ...validInput,
      currency: "USD",
    })

    expect(Exit.isFailure(result)).toBe(true)
  })

  it("rejects a DueDate that is not immediately due", () => {
    const result = Schema.decodeUnknownExit(IssueAuthorisedSalesInvoiceInput)({
      ...validInput,
      dueDate: "2026-03-16",
    })

    expect(Exit.isFailure(result)).toBe(true)
  })
})
