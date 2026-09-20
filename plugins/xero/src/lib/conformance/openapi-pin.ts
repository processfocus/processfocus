/**
 * Pinned official Xero Accounting OpenAPI revision.
 *
 * This is the transport reference for paths, request fields, and response
 * fields the plugin actually uses. Demo Company behavior and Xero's prose
 * remain authority for tax calculation, Item defaults, idempotency retention,
 * rate limits, and validation messages that the schema does not fully
 * describe.
 *
 * Refresh by updating `revision` to an exact Xero-OpenAPI commit of
 * xero_accounting.yaml and adjusting the excerpt if used fields changed.
 * Drift checks observe live write payloads and wire decode schemas. Do not
 * fetch the spec from routine CI.
 */
export const XERO_ACCOUNTING_OPENAPI_PIN = {
  repository: "https://github.com/XeroAPI/Xero-OpenAPI",
  path: "xero_accounting.yaml",
  revision: "853dc01a99c179d21df3a0b4f870ed612aebf3e3",
  version: "17.0.0",
  committedAt: "2026-08-12T23:17:28Z",
  specUrl:
    "https://raw.githubusercontent.com/XeroAPI/Xero-OpenAPI/853dc01a99c179d21df3a0b4f870ed612aebf3e3/xero_accounting.yaml",
  serverUrl: "https://api.xero.com/api.xro/2.0",
} as const

/**
 * Accounting OpenAPI excerpt for the plugin's used transport. Field names
 * come from revision 853dc01a of xero_accounting.yaml.
 */
export const XERO_ACCOUNTING_OPENAPI_EXCERPT = {
  paths: {
    "/Contacts": {
      get: "getContacts",
      post: "updateOrCreateContacts",
    },
    "/Invoices": {
      get: "getInvoices",
      post: "updateOrCreateInvoices",
    },
    "/Invoices/{InvoiceID}": {
      get: "getInvoice",
    },
    "/Invoices/{InvoiceID}/Email": {
      post: "emailInvoice",
    },
  },
  parameters: {
    summarizeErrors: "query",
    idempotencyKey: "header",
    where: "query",
  },
  schemas: {
    Contact: [
      "ContactID",
      "Name",
      "EmailAddress",
      "Addresses",
      "ValidationErrors",
    ],
    Address: [
      "AddressType",
      "AddressLine1",
      "AddressLine2",
      "City",
      "Region",
      "PostalCode",
      "Country",
    ],
    Invoice: [
      "Type",
      "Contact",
      "LineItems",
      "Date",
      "DueDate",
      "LineAmountTypes",
      "InvoiceNumber",
      "Reference",
      "CurrencyCode",
      "Status",
      "SubTotal",
      "TotalTax",
      "Total",
      "InvoiceID",
      "ValidationErrors",
    ],
    LineItem: [
      "Description",
      "Quantity",
      "UnitAmount",
      "ItemCode",
      "LineAmount",
      "TaxType",
      "TaxAmount",
    ],
    Error: ["ErrorNumber", "Type", "Message", "Elements"],
    Element: ["ValidationErrors", "ContactID", "InvoiceID"],
    ValidationError: ["Message"],
  },
} as const

export const PLUGIN_USED_ACCOUNTING_PATHS = [
  "/Contacts",
  "/Invoices",
  "/Invoices/{InvoiceID}",
] as const

export const PLUGIN_UNUSED_ACCOUNTING_PATHS = [
  "/Invoices/{InvoiceID}/Email",
] as const

/**
 * Fields decoded from live Demo responses that the Accounting OpenAPI Error
 * schema does not list. Observed Demo behavior is authority here.
 */
export const OBSERVED_EXTRA_ERROR_FIELDS = ["Title", "Detail"] as const
