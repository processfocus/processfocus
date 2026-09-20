import { Schema } from "effect"
import { IssueAuthorisedSalesInvoiceInput } from "../identities"
import {
  xeroContactWritePayload,
  xeroInvoiceWritePayload,
} from "../xero-invoice-live"
import {
  XeroContact,
  XeroErrorResponse,
  XeroInvoiceContactWire,
  XeroInvoiceLineWire,
  XeroInvoiceWire,
  XeroValidationError,
} from "../xero-wire"
import {
  OBSERVED_EXTRA_ERROR_FIELDS,
  PLUGIN_UNUSED_ACCOUNTING_PATHS,
  PLUGIN_USED_ACCOUNTING_PATHS,
  XERO_ACCOUNTING_OPENAPI_EXCERPT,
  XERO_ACCOUNTING_OPENAPI_PIN,
} from "./openapi-pin"
import { describe, expect, it } from "bun:test"

const includesAll = (
  actual: readonly string[],
  required: readonly string[],
): boolean => required.every((field) => actual.includes(field))

const structKeys = (schema: { readonly fields: Record<string, unknown> }) =>
  Object.keys(schema.fields)

const sampleInput = Schema.decodeUnknownSync(IssueAuthorisedSalesInvoiceInput)({
  customer: { name: "Ada Lovelace", email: "ada@example.com" },
  shippingAddress: {
    line1: "10 Customhouse Quay",
    line2: "Level 2",
    city: "Wellington",
    region: "Wellington",
    postalCode: "6011",
    country: "New Zealand",
  },
  productSku: "TBS-100",
  agreedPrice: "100.00",
  currency: "NZD",
  reference: "ORD-1001",
  date: "2026-03-15",
  dueDate: "2026-03-15",
})

describe("Xero Accounting OpenAPI pin", () => {
  it("pins an exact Xero-OpenAPI revision of xero_accounting.yaml", () => {
    expect(XERO_ACCOUNTING_OPENAPI_PIN.revision).toMatch(/^[0-9a-f]{40}$/)
    expect(XERO_ACCOUNTING_OPENAPI_PIN.path).toBe("xero_accounting.yaml")
    expect(XERO_ACCOUNTING_OPENAPI_PIN.version).toBe("17.0.0")
    expect(XERO_ACCOUNTING_OPENAPI_PIN.specUrl).toContain(
      XERO_ACCOUNTING_OPENAPI_PIN.revision,
    )
    expect(XERO_ACCOUNTING_OPENAPI_PIN.serverUrl).toBe(
      "https://api.xero.com/api.xro/2.0",
    )
  })

  it("keeps live write payload fields inside the pinned excerpt", () => {
    const created = xeroContactWritePayload(
      sampleInput,
      "Ada Lovelace",
      undefined,
    )
    const updated = xeroContactWritePayload(
      sampleInput,
      "Ada Lovelace",
      "33333333-3333-4333-8333-333333333333",
    )
    const contact = created.Contacts[0]
    const updatedContact = updated.Contacts[0]
    const address = contact?.Addresses[0]
    expect(contact).toBeDefined()
    expect(updatedContact).toBeDefined()
    expect(address).toBeDefined()
    if (contact === undefined || updatedContact === undefined) {
      throw new Error("expected contact write payloads")
    }
    if (address === undefined) {
      throw new Error("expected STREET address on contact write payload")
    }

    const contactKeys = [
      ...new Set([...Object.keys(contact), ...Object.keys(updatedContact)]),
    ].filter((key) => key !== "Addresses")
    expect(
      includesAll(XERO_ACCOUNTING_OPENAPI_EXCERPT.schemas.Contact, contactKeys),
    ).toBe(true)
    expect(
      includesAll(
        XERO_ACCOUNTING_OPENAPI_EXCERPT.schemas.Address,
        Object.keys(address),
      ),
    ).toBe(true)

    const invoice = xeroInvoiceWritePayload(
      "33333333-3333-4333-8333-333333333333",
      sampleInput,
    ).Invoices[0]
    expect(invoice).toBeDefined()
    if (invoice === undefined) {
      throw new Error("expected invoice write payload")
    }
    const line = invoice.LineItems[0]
    expect(line).toBeDefined()
    if (line === undefined) {
      throw new Error("expected invoice line write payload")
    }

    expect(
      includesAll(
        XERO_ACCOUNTING_OPENAPI_EXCERPT.schemas.Invoice,
        Object.keys(invoice).filter((key) => key !== "LineItems"),
      ),
    ).toBe(true)
    expect(
      includesAll(
        XERO_ACCOUNTING_OPENAPI_EXCERPT.schemas.LineItem,
        Object.keys(line),
      ),
    ).toBe(true)
  })

  it("keeps live wire decode fields inside the pinned excerpt", () => {
    expect(
      includesAll(
        XERO_ACCOUNTING_OPENAPI_EXCERPT.schemas.Contact,
        structKeys(XeroContact),
      ),
    ).toBe(true)
    expect(
      includesAll(
        XERO_ACCOUNTING_OPENAPI_EXCERPT.schemas.Contact,
        structKeys(XeroInvoiceContactWire),
      ),
    ).toBe(true)
    expect(
      includesAll(
        XERO_ACCOUNTING_OPENAPI_EXCERPT.schemas.Invoice,
        structKeys(XeroInvoiceWire),
      ),
    ).toBe(true)
    expect(
      includesAll(
        XERO_ACCOUNTING_OPENAPI_EXCERPT.schemas.LineItem,
        structKeys(XeroInvoiceLineWire),
      ),
    ).toBe(true)
    expect(
      includesAll(
        XERO_ACCOUNTING_OPENAPI_EXCERPT.schemas.ValidationError,
        structKeys(XeroValidationError),
      ),
    ).toBe(true)

    const pinnedErrorFields = [
      ...XERO_ACCOUNTING_OPENAPI_EXCERPT.schemas.Error,
      ...OBSERVED_EXTRA_ERROR_FIELDS,
    ]
    expect(includesAll(pinnedErrorFields, structKeys(XeroErrorResponse))).toBe(
      true,
    )
  })

  it("records invoice emailing as present in the spec and unused by the plugin", () => {
    expect(
      XERO_ACCOUNTING_OPENAPI_EXCERPT.paths["/Invoices/{InvoiceID}/Email"],
    ).toEqual({ post: "emailInvoice" })
    expect(PLUGIN_UNUSED_ACCOUNTING_PATHS).toContain(
      "/Invoices/{InvoiceID}/Email",
    )
    expect(PLUGIN_USED_ACCOUNTING_PATHS).not.toContain(
      "/Invoices/{InvoiceID}/Email",
    )
    for (const path of PLUGIN_USED_ACCOUNTING_PATHS) {
      expect(path in XERO_ACCOUNTING_OPENAPI_EXCERPT.paths).toBe(true)
    }
  })

  it("pins SummarizeErrors and Idempotency-Key as used transport parameters", () => {
    expect(XERO_ACCOUNTING_OPENAPI_EXCERPT.parameters.summarizeErrors).toBe(
      "query",
    )
    expect(XERO_ACCOUNTING_OPENAPI_EXCERPT.parameters.idempotencyKey).toBe(
      "header",
    )
  })
})
