import { Schema } from "effect"
import { XeroContactId } from "./identities"

export const XeroTokenResponse = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.String,
  expires_in: Schema.Number,
  scope: Schema.optional(Schema.String),
})

export const XeroTokenErrorResponse = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optional(Schema.String),
})

const XeroConnection = Schema.Struct({
  tenantId: Schema.String,
  tenantType: Schema.optional(Schema.String),
})

export const XeroConnectionsResponse = Schema.Array(XeroConnection)

export const XeroValidationError = Schema.Struct({
  Message: Schema.optional(Schema.String),
})

const XeroErrorElement = Schema.Struct({
  ValidationErrors: Schema.optional(Schema.Array(XeroValidationError)),
})

export const XeroErrorResponse = Schema.Struct({
  Type: Schema.optional(Schema.String),
  Title: Schema.optional(Schema.String),
  Detail: Schema.optional(Schema.String),
  Message: Schema.optional(Schema.String),
  Elements: Schema.optional(Schema.Array(XeroErrorElement)),
})

export const XeroContact = Schema.Struct({
  ContactID: XeroContactId,
  Name: Schema.optional(Schema.String),
  EmailAddress: Schema.optional(Schema.String),
})

export const XeroContactsResponse = Schema.Struct({
  Contacts: Schema.Array(XeroContact),
})

const XeroWireAmount = Schema.Union(Schema.Number, Schema.String)

export const XeroInvoiceContactWire = Schema.Struct({
  ContactID: Schema.optional(XeroContactId),
})

export const XeroInvoiceLineWire = Schema.Struct({
  ItemCode: Schema.optional(Schema.String),
  Quantity: Schema.optional(XeroWireAmount),
  UnitAmount: Schema.optional(XeroWireAmount),
  LineAmount: Schema.optional(XeroWireAmount),
})

export const XeroInvoiceWire = Schema.Struct({
  InvoiceID: Schema.String,
  InvoiceNumber: Schema.String,
  Status: Schema.String,
  Type: Schema.optional(Schema.String),
  Reference: Schema.optional(Schema.String),
  CurrencyCode: Schema.optional(Schema.String),
  Date: Schema.optional(Schema.String),
  DueDate: Schema.optional(Schema.String),
  Contact: Schema.optional(XeroInvoiceContactWire),
  LineItems: Schema.optional(Schema.Array(XeroInvoiceLineWire)),
  Total: Schema.optional(XeroWireAmount),
})

export const XeroInvoicesResponse = Schema.Struct({
  Invoices: Schema.Array(XeroInvoiceWire),
})
