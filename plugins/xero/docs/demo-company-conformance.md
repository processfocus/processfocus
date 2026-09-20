# Xero Demo Company conformance

The Xero plugin's highest-drift behaviors are checked against a dedicated
Xero Demo Company through an opt-in Nx target. Default plugin tests skip
the live canary unless `XERO_DEMO_CONFORMANCE=1`, so routine CI never
contacts Xero and never requires Custom Connection credentials.

## Guard

Run the live canary only against a **dedicated NZ Demo Company** Custom
Connection:

```bash
bun scripts/nx-quiet.ts run @processfocus/plugin-xero:conformance
```

The target sets `XERO_DEMO_CONFORMANCE=1` and requires:

- `XERO_CLIENT_ID`
- `XERO_CLIENT_SECRET`

Optional:

- `XERO_SCOPES` — defaults to `accounting.invoices accounting.contacts`
- `XERO_DEMO_ZERO_ITEM` — defaults to `PF-ZERO`
- `XERO_DEMO_GST_ITEM` — defaults to `PF-GST15`

The canary uses the live adapter at the `XeroInvoice` plugin interface. It
creates uniquely referenced contacts and authorised invoices, then compares
observable totals, status, contact reuse, idempotent replay, and validation
decoding with the stateful test adapter. It never posts
`/Invoices/{InvoiceID}/Email` and must not be pointed at a production
organisation.

## Pre-provisioned catalog Items

Create these sold Items once in the dedicated NZ Demo Company. The plugin
does not manage the Item catalog.

| ItemCode | Name | Sales tax | Expected $100.00 inclusive result |
| --- | --- | --- | --- |
| `PF-ZERO` | PF Conformance Zero Tax | NONE / No Tax | Total `100.00`, tax `0.00` |
| `PF-GST15` | PF Conformance GST 15 | OUTPUT2 / GST on Income 15% | Total `100.00`, tax `13.04` |

Use a New Zealand Demo Company so GST is 15 percent. The canary sends
`LineAmountTypes=Inclusive` and quantity one; the Item supplies account and
tax defaults.

## Unique Order Number References

Each run generates Order Number References of the form `PF{runId}{scenario}`
so earlier canary invoices cannot collide with the current run.

## OpenAPI pin

Transport fields are pinned to Xero-OpenAPI commit
`853dc01a99c179d21df3a0b4f870ed612aebf3e3` (`xero_accounting.yaml` 17.0.0).
Routine tests check that used request and response fields still exist in that
excerpt. Tax calculation, idempotency retention, rate limits, and validation
wording are taken from observed Demo behavior and Xero's official prose, not
from the schema.

To refresh the pin, update `src/lib/conformance/openapi-pin.ts` to a new exact
revision and re-check the used-field excerpt. Do not fetch the spec from
routine CI.

## Demo Company reset and reconnection

Xero resets a Demo Company automatically after 28 days, and a user can reset
it from My Xero at any time. Changing the Demo Company country also resets
it.

After a reset:

1. Recreate the `PF-ZERO` and `PF-GST15` Items.
2. Reconnect the Custom Connection to the Demo Company. A reset drops the
   previous organisation identity, so the app must be authorised again.
3. Re-run the conformance target.

Until the Custom Connection is reconnected, token or connections calls fail
as a deployment or authentication fault rather than a business retry.

## Captured evidence

Canary fixtures and diagnostics may include Order Number, Xero resource IDs,
customer name, and customer email. They omit Shipping Address, raw request
and response bodies, access tokens, client secrets, and Authorization
headers.
