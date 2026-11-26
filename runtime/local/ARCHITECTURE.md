# Local runtime architecture

The local runtime brings the same process execution services used in hosting
onto one machine:

- **Dashboard** provides the user interface.
- **GraphQL server** serves application data and enforces authorisation.
- **Authentication server** verifies identity and issues credentials.
- **Job worker** runs background process work.
- **Import watcher** keeps the database's organisation model up to date.

Authentication is separate from application authorisation: the issuer does not
load organisation code or Cedar policies. See
[ADR 0037](../../docs/adr/0037-issuers-validate-credentials-protected-boundaries-authorize.md)
for that boundary.

## Startup and organisation state

The runtime needs both executable organisation code and imported database
state. Import also generates artifacts such as the organisation's GraphQL
schema. Loading new code alone does not refresh all of those inputs.

Startup imports the organisation before starting services. The repository's
`serve` target also checks worker dependencies before launching them, so missing
configuration fails startup rather than leaving background work unavailable.
The import watcher takes over after bootstrap.

## Editing and reloading

In repository development, Bun watches backend code and Next.js provides
Dashboard fast refresh. The installed runtime instead serves a built Dashboard;
frontend changes require rebuilding it.

| Change | How it becomes visible during repository development |
| --- | --- |
| Runtime or imported organisation code | The affected backend process restarts. |
| Process definitions and form metadata | Import watch refreshes database state and notifies connected views. |
| Generated GraphQL schema shape | Wait for import, then restart GraphQL and reload the view. |
| Custom Cedar policies | Policies reload in place; frontend permission caches are invalidated. |
| Cedar schema | Restart GraphQL and the worker. |

If a watched import fails, correct the error and save again. Public and embedded
forms may need rebuilding/importing and reopening to load their updated inputs.

## Background work

The local queue shares the database with business state, allowing a transaction
to commit both together. An enqueue inside a transaction is provisional until
the outer transaction commits.

The worker favours fresh work over retries and newer work within the same
attempt priority. This helps interactive development, but older jobs can wait
indefinitely under a continuous stream of higher-priority arrivals.

Attempts have execution deadlines. A separate supervisor can stop and replace
a stuck worker, while independently observing queue health and recovering
exhausted work. Progress depends on a running supervisor and an available
database. Terminal records retain failure information; redrive explicitly
creates new work rather than resetting the old attempt budget.

Delivery is at least once. A timeout or lost acknowledgement can leave an
external action's outcome unknown, so handlers must tolerate retries.

The supervisor writes health and queue observations to
`.queue-worker-state.json` under the runtime root, or `PF_LOCAL_QUEUE_STATE_FILE`.
Use its health, timestamps, and error status together: zero active jobs alone
does not establish that the worker is healthy.

Implementation entry points are in [`src/job-worker/`](src/job-worker/).
The [queue models](formal/queue/README.md) explain the scope of formal checking.
