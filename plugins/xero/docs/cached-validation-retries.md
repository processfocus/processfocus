# Retrying rejected Xero invoices

Xero can cache a rejected invoice request. Correcting an Item's sales settings
does not necessarily make an identical retry succeed immediately.

## Recovery policy

Correct the reported catalogue problem, then restart the failed execution.
For Todo-backed invoice steps, a recorded validation rejection allows the next
attempt to use a new write identity. The plugin still checks for an existing
invoice with the same business reference before creating one.

A timeout or lost response does not prove rejection. Check Xero before taking
further action; do not change the business reference or manually replace retry
keys to force another invoice.

Older failures without a recorded rejection may replay that rejection on the
first restart. A later restart can then use the recorded replacement identity.
System-start steps without a Todo do not have this recovery mechanism.
