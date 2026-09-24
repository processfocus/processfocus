# @processfocus/plugin-xero

Xero Sales Invoice plugin for Process Focus business processes. Process
authors receive one `XeroInvoiceStep` that issues a single authorised
accounts-receivable invoice. Custom Connection authentication, REST transport,
Xero wire schemas, catalog defaults, and response decoding stay behind that
interface.

## Installation

This package is part of the workspace. Add it to your process dependencies:

```json
{
  "dependencies": {
    "@processfocus/plugin-xero": "0.1.0-next.2"
  }
}
```

## Configuration

The live Layer authenticates with a single-organisation Xero Custom Connection.
Set these environment variables:

- `XERO_CLIENT_ID` - Custom Connection client id
- `XERO_CLIENT_SECRET` - Custom Connection client secret
- `XERO_SCOPES` - optional space-separated scopes. Defaults to
  `accounting.invoices accounting.contacts`

For cloud-hosted deployments, use `pfcli` to set the secret:

```bash
bun cli/pfcli/src/main.ts config set XERO_CLIENT_ID="..." --project <project-id> --stage "<stage-name>"
bun cli/pfcli/src/main.ts config set XERO_CLIENT_SECRET="..." --project <project-id> --stage "<stage-name>" --secret
```

Provide the live Layer from the organisation's custom job layer. Deployed
runtimes must require this configuration; they never fall back to the stateful
test adapter.

```typescript
import { Layer } from "effect"
import {
  XeroInvoiceConfigFromEnv,
  XeroInvoiceLive,
} from "@processfocus/plugin-xero/runtime"

export const CustomJobLayer = Layer.provide(
  XeroInvoiceLive,
  XeroInvoiceConfigFromEnv,
)
```

## Usage

```typescript
import { Effect } from "effect"
import {
  decodeIssueAuthorisedSalesInvoiceInput,
  XeroInvoiceStep,
} from "@processfocus/plugin-xero"

const createInvoice = new XeroInvoiceStep(flow, "Create Xero Invoice", {
  input: (state) =>
    decodeIssueAuthorisedSalesInvoiceInput({
      customer: {
        name: state.customerName,
        email: state.customerEmail,
      },
      shippingAddress: {
        line1: state.addressLine1,
        city: state.city,
      },
      productSku: state.productSku,
      agreedPrice: state.agreedPrice,
      currency: "NZD",
      reference: state.orderNumber,
      date: state.orderDate,
      dueDate: state.orderDate,
    }),
})
```

The step returns `{ invoiceId, invoiceNumber }` from Xero.

The invoice is one ACCREC AUTHORISED line with quantity one. Product SKU is
sent as ItemCode. Amounts are tax-inclusive. The Xero Item supplies account
and tax defaults, so a zero-tax Item and a GST Item keep the same Agreed Price
as the invoice total.

Contact matching uses trimmed, lowercase email comparison. Exactly one match
is reused and updated with the current customer name, email, and physical
STREET address from the Shipping Address. Postal and billing addresses are
left unchanged. Zero matches or multiple matches create a new contact. One
normalized email can correspond to multiple Xero contacts; the plugin never
picks an arbitrary match. If Xero rejects the contact name as not unique, the
plugin retries with the customer name plus the Order Number. A later attempt
looks up that deterministic name first so the created contact can be
reconciled.

Contact and invoice writes send distinct `Idempotency-Key` headers derived
from the system-step Todo identity. Identical retries inside Xero's six-minute
window replay the original result. After that window expires, contact creation
is recovered from the existing provider contact, and invoice creation queries
the exact Order Number Reference before another create. One materially
compatible invoice is treated as success. Multiple invoices with that
Reference, or one whose contact, Product SKU, amount, currency, dates, type,
or status conflict, fail without changing an authorised invoice.

## Draft-Only Creation

`XeroDraftInvoice.createIfAbsent(DraftSalesInvoice)` creates a multi-line ACCREC
**DRAFT** for an already resolved contact. Provide `XeroDraftInvoiceLive` from
`/runtime` with `XeroInvoiceConfig`. The schema requires internally consistent
integer-cent inclusive amounts and rejects any status other than DRAFT.

Every attempt rereads all invoices for that contact. A matching reference, either
bare or followed by a whitespace-separated suffix, is skipped regardless of
status or amount. Failed, malformed or incomplete lookups never imply absence.
The POST omits InvoiceID and InvoiceNumber, leaves contacts untouched, and never
authorises or emails the invoice. The response must match the requested contact,
reference, dates, signed lines, totals and GST before returning `created-draft`.
Before a new write, the adapter rereads the contact and requires its primary
email plus `IncludeInEmails` contact-person addresses to exactly match
`expectedRecipientEmails`. Legacy saved previews without that intent can still
be decoded, but a new write is refused until they are prepared again.

The stable idempotency key is derived from tenant, contact and normalized
reference, so competing executions use the same provider key. An optional
`duplicateReference` supplies the stable scope for both the lookup and key when
`reference` includes a display suffix (for example `T4 2026 Lexine Y10` with
scope `T4 2026`). It must match the display reference using the same
whitespace-separated suffix rule; it is not sent to Xero. After Xero's
six-minute key retention expires, the fresh lookup still prevents re-creation.
The adapter serializes its own lookup/write pairs, paces accounting requests and
retains the shared Retry-After/error handling. Manual external writers cannot be
locked by this API; the lookup is performed immediately before each write.

## Testing

### Read-Only Invoice Planning

Processes that need to plan invoices without writing can use `XeroInvoiceLookup`
from the main entry point, backed by `XeroInvoiceLookupLive` from `/runtime` and
the same `XeroInvoiceConfigFromEnv` configuration. `readDirectory(reference, previousReference?)`
returns all contacts (including archived contacts, normalized main/contact-person
emails) and ACCREC invoice identities whose references contain either supplied
reference. `invoiceRecipientEmails` contains only enabled invoice recipients,
separately from all emails usable for identity matching.
It performs paginated reads only; it never creates or updates a contact or invoice.
The caller owns exact reference/contact matching and the decision to skip.
Pagination rejects repeated identities, partial responses and malformed required
fields, and fails if the 1,000-page bound is reached. Transport, authentication,
token caching and rate-limit handling are shared with the existing live adapter.

This interface does not change the order-invoice step's write or reconciliation
semantics. In particular, a read-only preview is not issuance and does not provide
concurrent-write idempotency.

### Test Adapters

```bash
bun scripts/nx-quiet.ts run @processfocus/plugin-xero:test
```

Tests import `makeXeroInvoiceTestPlugin()` from
`@processfocus/plugin-xero/test-support`. It returns `{ layer, controller }`.

An opt-in Demo Company canary reuses those scenarios against the live
adapter. Default tests skip it unless `XERO_DEMO_CONFORMANCE=1`, so
routine CI never contacts Xero:

```bash
bun scripts/nx-quiet.ts run @processfocus/plugin-xero:conformance
```

The canary requires `XERO_CLIENT_ID` and `XERO_CLIENT_SECRET` for a
dedicated NZ Demo Company Custom Connection, uses unique Order Number
References, and compares observable live results with the stateful test
adapter. See `docs/demo-company-conformance.md` for pre-provisioned
`PF-ZERO` and `PF-GST15` Items, reset/reconnection, and the pinned
Accounting OpenAPI revision. The canary does not email invoices and must
not be pointed at a production organisation.

The controller seeds contacts, catalog Items, invoices, and rate budgets, and
inspects created resources without network access. Seeding may create
duplicate normalized emails, duplicate names, physical STREET addresses, and
billing/postal addresses. It also models Xero idempotency retention and
expiry, changed-body key conflicts, timeout-after-commit, seeded References,
deterministic time, and scripted transport, timeout, validation, auth,
permission, rate-limit, malformed-response, and provider-server failures.
Test support is not re-exported from the package root or runtime entry point.

Network failures, timeouts, HTTP 429, and Xero 500/503 responses are
retryable. Rate-limit responses wait for Retry-After before the retryable
failure is returned. Validation, unknown ItemCode, ambiguous Reference,
conflicting intent, and unsupported operations fail immediately without
retry. Missing or malformed Custom Connection configuration, malformed
success payloads, and persistent 401/403 failures are deployment or
provider-contract faults and also fail immediately.

The live adapter caches Custom Connection access tokens until shortly before
expiry and coalesces concurrent refreshes. Logs may include Order Number,
Xero resource IDs, customer name, and customer email. Logs and errors omit
Shipping Address, raw request and response bodies, access tokens, client
secrets, and Authorization headers.
