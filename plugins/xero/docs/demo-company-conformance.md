# Live Xero conformance checks

The opt-in conformance target checks the plugin against Xero. It creates contacts
and authorised invoices, so use a dedicated New Zealand test company and its
Custom Connection, never a production organisation.

Set `XERO_CLIENT_ID` and `XERO_CLIENT_SECRET`, then run from the workspace root:

```bash
bun scripts/nx-quiet.ts run @processfocus/plugin-xero:conformance
```

Prepare two sold Items in that company:

| Item code | Sales tax |
| --- | --- |
| `PF-ZERO` | No Tax (`NONE`) |
| `PF-GST15` | GST on Income 15% (`OUTPUT2`) |

Both need valid sales accounts. After resetting the test company, reconnect the
Custom Connection and recreate the Items.

Ordinary plugin tests use the local adapter and do not require Xero credentials.
