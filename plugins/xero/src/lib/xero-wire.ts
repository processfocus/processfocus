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

export const XeroAddress = Schema.Struct({
  AddressType: Schema.Literals(["POBOX", "STREET", "DELIVERY"]),
  AttentionTo: Schema.optional(Schema.NullOr(Schema.String)),
  AddressLine1: Schema.optional(Schema.NullOr(Schema.String)),
  AddressLine2: Schema.optional(Schema.NullOr(Schema.String)),
  AddressLine3: Schema.optional(Schema.NullOr(Schema.String)),
  AddressLine4: Schema.optional(Schema.NullOr(Schema.String)),
  City: Schema.optional(Schema.NullOr(Schema.String)),
  Region: Schema.optional(Schema.NullOr(Schema.String)),
  PostalCode: Schema.optional(Schema.NullOr(Schema.String)),
  Country: Schema.optional(Schema.NullOr(Schema.String)),
})

// A detail read must actually include Addresses; a projected contact cannot
// establish that billing is empty. An empty array means no address slots.
export const XeroContactDetailsResponse = Schema.Struct({
  Contacts: Schema.Array(
    Schema.Struct({
      ...XeroContact.fields,
      Addresses: Schema.Array(XeroAddress),
    }),
  ),
})

const XeroWireAmount = Schema.Union([Schema.Number, Schema.String])

export const XeroInvoiceContactWire = Schema.Struct({
  ContactID: Schema.optional(XeroContactId),
})

export const XeroInvoiceLineWire = Schema.Struct({
  ItemCode: Schema.optional(Schema.String),
  Description: Schema.optional(Schema.String),
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
