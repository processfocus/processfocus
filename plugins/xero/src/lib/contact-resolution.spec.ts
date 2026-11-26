import {
  XERO_CONTACT_NAME_MUST_BE_UNIQUE,
  isContactNameConflict,
} from "./contact-resolution"
import { normalizeEmail } from "./identities"
import { describe, expect, it } from "bun:test"

describe("Xero contact resolution policy", () => {
  it("trims and lowercases email for exact semantic comparison", () => {
    expect(normalizeEmail("  ADA@Example.COM ")).toBe("ada@example.com")
    expect(normalizeEmail("ada@example.com")).toBe("ada@example.com")
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
