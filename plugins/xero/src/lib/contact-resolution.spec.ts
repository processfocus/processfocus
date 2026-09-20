import { Schema } from "effect"
import {
  XERO_CONTACT_NAME_MUST_BE_UNIQUE,
  conflictContactName,
  isContactNameConflict,
} from "./contact-resolution"
import {
  CustomerName,
  InvoiceReference,
  isUniqueEmailMatch,
  normalizeEmail,
} from "./identities"
import { describe, expect, it } from "bun:test"

describe("Xero contact resolution policy", () => {
  it("trims and lowercases email for exact semantic comparison", () => {
    expect(normalizeEmail("  ADA@Example.COM ")).toBe("ada@example.com")
    expect(normalizeEmail("ada@example.com")).toBe("ada@example.com")
  })

  it("treats exactly one email match as unique and any other count as ambiguous", () => {
    expect(isUniqueEmailMatch(1)).toBe(true)
    expect(isUniqueEmailMatch(0)).toBe(false)
    expect(isUniqueEmailMatch(2)).toBe(false)
  })

  it("appends Order Number to form the deterministic conflict name", () => {
    expect(
      conflictContactName({
        customerName: Schema.decodeUnknownSync(CustomerName)("Ada Lovelace"),
        orderNumber: Schema.decodeUnknownSync(InvoiceReference)("ORD-1001"),
      }),
    ).toBe("Ada Lovelace ORD-1001")
  })

  it("detects Xero unique-name validation messages", () => {
    expect(isContactNameConflict(XERO_CONTACT_NAME_MUST_BE_UNIQUE)).toBe(true)
    expect(
      isContactNameConflict(
        "The contact name is already assigned to another contact",
      ),
    ).toBe(true)
    expect(isContactNameConflict("Item code 'TBS-100' is not valid")).toBe(
      false,
    )
    expect(isContactNameConflict("Xero request failed (500)")).toBe(false)
  })
})
