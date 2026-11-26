# @processfocus/plugin-xero

Connects Process Focus processes to Xero sales invoicing.

## Setup

Use a single-organisation Xero Custom Connection:

| Setting | Purpose |
| --- | --- |
| `XERO_CLIENT_ID` | Custom Connection client ID |
| `XERO_CLIENT_SECRET` | Secret client credential |
| `XERO_SCOPES` | Defaults to `accounting.invoices accounting.contacts` |

Provide the live services from `@processfocus/plugin-xero/runtime` through the
organisation's custom job layer, with `XeroInvoiceConfigFromEnv` and an HTTP
client. Include `XeroConfiguration` in the organisation's configuration contract.
Use `makeXeroConfiguration` when binding credentials to different setting names.

Store hosted secrets with `pfcli config set --secret` and redeploy after changes.
Xero Items must have the sales account and tax settings needed by your invoices.

## Choose an operation

| API | Use |
| --- | --- |
| `XeroInvoiceStep` | Issue an authorised sales invoice from a process |
| `XeroInvoiceCancellationStep` | Void an invoice using its stored Xero identity |
| `XeroInvoiceLookup` | Read contacts and invoice references for planning |
| `XeroInvoicePreparation` | Read contacts and current sales-item details |
| `XeroDraftInvoice.createIfAbsent` | Create a draft only when its contact/reference is absent |
| `XeroRepeatedDraftInvoice.create` | Intentionally allow another draft with the same reference |

Read-only preparation does not issue an invoice. Item preparation also requires
the `accounting.settings` scope. Draft creation does not authorise or email invoices.

## Process authoring

Import the step and input decoder from the package root:

```ts
import {
  XeroInvoiceStep,
  decodeIssueAuthorisedSalesInvoiceInput,
} from "@processfocus/plugin-xero"

const createInvoice = new XeroInvoiceStep(flow, "Create invoice", {
  input: (state) => decodeIssueAuthorisedSalesInvoiceInput(state.invoice),
})
```

The authorised invoice input describes the customer, shipping address, item
lines, dates and reference. Prices are tax-inclusive NZD amounts. Use a stable,
unique business reference so retries can find an invoice already issued.
Keep the returned invoice identity for later cancellation or reconciliation.

Cancellation voids the existing invoice; it does not refund payments or issue a
replacement. Xero determines whether the invoice can be voided.

## Recovery and development

After an uncertain write, check Xero before starting another operation.
Repeated-reference draft creation deliberately permits duplicates across
invocations.

For a rejected invoice after correcting item settings, follow the
[recovery policy](docs/cached-validation-retries.md#recovery-policy).

`@processfocus/plugin-xero/test-support` supplies a stateful adapter for local
development. [Live conformance checks](docs/demo-company-conformance.md) are
available separately.
