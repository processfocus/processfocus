# Disposable Local Delegation Realtime Evidence

The #2963 presentation update replaces the banner with profile-menu identity.
The current lifecycle probe checks the profile trigger for delegated/human
transitions; “indicator” below describes the historical run. See the
[profile verification record](../../docs/authentication/delegated-profile-verification.md)
for current presentation and evidence.

Issue: #2902. This record covers the disposable fixture and browser probe, not
the separate core GraphQL implementation or public runtime activation.

## Final Passing Run

The final combined **1440x1000 and 390x844** run passed **all 32 checks** against
the corrected Fetch(Request) handling, restartable frontend streams, and session
binding. It used the real Next 16.2.11 **Turbopack development** runtime, SQLite,
issuer, Cedar, Yoga, graphql-ws, serial worker, and agent-browser interactions.

The authoritative passing artifacts are exclusively under:

`/tmp/ready-for-agent/pr-attachments/wi-01M1WH4X809R5N94ATBSRHNF7X/review-cessation-final/`

This directory contains 32 secret-free screenshots, the 32-check
`joined-lifecycle-results.json`, and two `joined-transition-diagnostics-*.json`
files. The earlier `confirmed-final-pass/final/` run is historical passing
evidence without the new cessation HTTP/DOM assertions; other intermediate
attempts are not current acceptance. The recorded local-clock interval is
`2026-09-07T22:06:46.370Z` through `2026-09-07T22:15:25.985Z`.

Both viewports passed genuine issuance/login, process submission and Todo
completion, rename preservation, replacement/revocation, old-secret rejection,
replacement login, retained HTTP/refresh/SSR rejection, and surviving accepted
work with delegation attribution. Before each invalidation, actual worker Todo
frames reached both subscribers and updated the agent page without navigation or
reload. New work triggered 60,000-60,003 ms after invalidation reached the human
subscriber but not the independent invalid agent; the two-second additional
delivery observation and original-document checks passed. All four cessation
cases additionally excluded matching `executionId` HTTP pulls and the exact new
Todo from the agent DOM. The matching human WebSocket event supplies `todoId`;
its action link must render in the human DOM and be absent in the agent DOM.
Both desktop cards and mobile rows use this URL parameter; the fixture repeats
the title `Review request`, so title counts cannot identify this fresh Todo.
The report records these asserted outcomes and business IDs, not raw payloads.
This is a bounded delivery observation and an end-of-window DOM check, not
continuous DOM monitoring or an exhaustive IndexedDB audit. HTTP/refresh/SSR
rejection was observed within 113-460 ms, not asserted as a production guarantee.

### Same-Browser Transition

An additional owner-browser tab genuinely logged in with the replacement secret
and received a worker event under the same delegated binding as the independent
agent. The original owner tab used the real server logout endpoint and signed in
with its existing genuine virtual passkey. No cookies or passkeys were copied or
injected. The human subscriber was re-established after these intentional cookie
changes, before taking the revocation baseline; it then continued without reload
through revocation and the subsequent event.

**Observed in this run, not required for a pass:** both existing
`joined-transition-diagnostics-1440.json` and
`joined-transition-diagnostics-390.json` record `explicitDocumentReentry: true`,
`sameBinding: false`, `websocketReceived: true`, and `httpReceived: false`.
Both same-browser entries in `joined-lifecycle-results.json` also record
`explicitDocumentReentry: true`. These are newly executed artifacts from the full
review-cessation rerun, not values copied from the historical pass.

In that observed re-entry branch, the probe's assertions checked a changed
`performance.timeOrigin`, a binding equal to the independent human subscriber's
binding, and removal of the delegated indicator. Combined with the passing
exclusion assertions, the diagnostics show the later worker event reached the
new human document over WebSocket, not HTTP pull, without entering the original
delegated binding or an unchanged document.

The observer associates each frame with its connection's actual binding and each
HTTP pull with its request header. Human-scope delivery is allowed only after a
verified new document boundary, with delivery/request timestamps after that
document's time origin. This distinguishes deliberate auth re-entry from silently
populating an old delegated view. The asserted invariant is exclusion of the
specific new event from the old restricted view, not mandatory re-entry or
delivery to this tab. Remaining in the original document with its delegated
binding and indicator, without receiving the event, also passes. `reentered`
selects the assertion branch; the diagnostic delivery booleans are not positive
delivery assertions. This is neither a requirement to become human or remain
delegated forever, nor an exhaustive audit of all IndexedDB records.

### Actual Commands

```bash
DELEGATION_PROBE_PORT=3498 bun runtime/local/scripts/delegation-next-runtime.ts
bun apps/frontend-e2e/scripts/delegation-lifecycle-probe.ts \
  /tmp/pf-delegation-next-UcLiDT/browser-handoff.json \
  /tmp/ready-for-agent/pr-attachments/wi-01M1WH4X809R5N94ATBSRHNF7X/review-cessation-final/
bun run biome check apps/frontend-e2e/scripts/delegation-lifecycle-probe.ts
bun run tsgo --noEmit -p apps/frontend-e2e/tsconfig.json
git diff --check -- apps/frontend-e2e
```

Probe-only fixes cleared stale subscription observations on full navigation,
used server logout before navigating to the login UI, established the human
revocation baseline after the intentional cookie transitions, and distinguished
explicit document re-entry from data received by the old binding. An attempted
Webpack workaround failed to locate Cedar WASM and was removed; no alternate
bundler or reload fallback is part of the final probe. Earlier Turbopack chunk
load failures were setup failures, not passing evidence.

Fixture and browser cleanup completed; port 3498 is free and the private handoff
directory was removed. No Nx, remote mutation, PR creation, or deployment was
performed. Exact expiry, checker failures, owner/role/login-authority changes,
feature disabling and forced reconnect/refresh recovery remain the coordinated
tests' responsibility, not claims of this browser run. Mobile is a Chromium
viewport with a virtual authenticator, not a physical device. Managed AppSync
and production builds were not tested.

## Resolved Header Blocker

The earlier rerun against the restartable stream/session-binding changes did not
pass. Both desktop and mobile completed genuine Invitation/passkey registration
and independent secret login, then stopped at ordinary work: the Dashboard
displayed **No processes found**. Direct Yoga/Cedar API access was accepted.
The corrected final run above supersedes this failure.

Historical failure artifacts are under:

`/tmp/ready-for-agent/pr-attachments/wi-01M1WH4X809R5N94ATBSRHNF7X/confirmed-final/`

The root contains the first desktop attempt; `attempt-2/` contains its fresh
reproduction; `mobile/` contains the focused mobile run. Each has a secret-free
failure screenshot and two completed checks. `mobile/joined-failure-results.json`
records the browser's GraphQL HTTP 415 responses.

The confirmed cause is in coordinator-owned
`apps/frontend/lib/collections/replication-factory.ts`: the fetch override builds
headers from `options?.headers`, but RxDB `graphQLRequest` invokes it with a
`Request` and no options. Replacing that Request's headers loses its
`Content-Type: application/json`. Real bound replication pulls consequently
return **415 Unsupported Media Type**, while ordinary unbound GraphQL requests
return 200. An actual OPTIONS request confirmed CORS allows the new binding
header, excluding a preflight block. The coordinator subsequently fixed the
override to preserve input Request headers before adding the binding header.
The coordinator's frontend file was not edited by this probe task.

Actual commands, each against a fresh fixture started with
`DELEGATION_PROBE_PORT=3498 bun runtime/local/scripts/delegation-next-runtime.ts`:

```bash
bun apps/frontend-e2e/scripts/delegation-lifecycle-probe.ts \
  /tmp/pf-delegation-next-zvrkSv/browser-handoff.json \
  /tmp/ready-for-agent/pr-attachments/wi-01M1WH4X809R5N94ATBSRHNF7X/confirmed-final
bun apps/frontend-e2e/scripts/delegation-lifecycle-probe.ts \
  /tmp/pf-delegation-next-VZzzof/browser-handoff.json \
  /tmp/ready-for-agent/pr-attachments/wi-01M1WH4X809R5N94ATBSRHNF7X/confirmed-final/attempt-2
bun apps/frontend-e2e/scripts/delegation-lifecycle-probe.ts \
  /tmp/pf-delegation-next-RpyppL/browser-handoff.json \
  /tmp/ready-for-agent/pr-attachments/wi-01M1WH4X809R5N94ATBSRHNF7X/confirmed-final/mobile mobile
```

The same-browser scenario could not execute past that earlier blocker. It has
since passed with the explicit document-reentry behavior recorded above.

The updated probe passed direct Biome and frontend-e2e TypeScript checks. No Nx
was run alongside the coordinator's verification. All three fixture processes,
probe browsers and the diagnostic browser were stopped; temporary handoffs were
removed. The throwaway diagnostic script was deleted. No remote mutation occurred.

## Previous Passing Run

The combined 1440x1000 and 390x844 journey passed all 28 recorded checks against
real Next development, issuer signing/verification, SQLite, Cedar, Yoga,
graphql-ws, and the serial queue worker. Visible interactions and screenshots
used agent-browser. A genuine Invitation and user-verifying resident virtual
passkey established the human owner; no owner-cookie injection was used.

The earlier passing evidence, before the final frontend binding changes, is under:

`/tmp/ready-for-agent/pr-attachments/wi-01M1WH4X809R5N94ATBSRHNF7X/confirmed-2/`

It contains `joined-lifecycle-results.json` and 26 secret-free screenshots.
Sibling directories contain other partial/debug runs. This is historical evidence,
not final acceptance for the current frontend changes.

Both viewports verified:

- Fresh owner issuance, independent agent secret login, ordinary process form
  submission and completion of a worker-created Todo through the Dashboard.
- Rename preserves the selected token's identity, generation and deadline.
- Before both replacement and revocation, a new worker-created Todo appears in
  the actual agent and human browser WebSocket frames and renders in the agent
  page without a reload or navigation.
- The original agent subscriber document stays open throughout independent owner
  replacement/revocation. New ordinary work is triggered 60,001-60,005 ms after
  invalidation. The resulting worker event reaches the original authorized human
  subscriber and not the invalid agent, including a further two-second delivery
  observation window. This is event evidence, not a connection-status assertion.
- Retained API read/submission, issuer refresh, Dashboard refresh and SSR
  credentials are rejected within 79-377 ms in this local run. These are observed
  timings, not exact-boundary tests or a production latency guarantee.
- Old secrets cannot log in; replacement secrets establish a distinct valid
  session. Accepted work survives revocation with delegated initiation attribution.

## Previous Commands

Fixture:

```bash
DELEGATION_PROBE_PORT=3498 bun runtime/local/scripts/delegation-next-runtime.ts
```

Passing browser command (the temporary handoff was removed on fixture shutdown):

```bash
bun apps/frontend-e2e/scripts/delegation-lifecycle-probe.ts \
  /tmp/pf-delegation-next-MInX2a/browser-handoff.json \
  /tmp/ready-for-agent/pr-attachments/wi-01M1WH4X809R5N94ATBSRHNF7X/confirmed-2
```

Checks passed without Nx:

```bash
bun run biome check --write runtime/local/scripts/delegation-next-runtime.ts apps/frontend-e2e/scripts/delegation-lifecycle-probe.ts
bun run tsgo --noEmit -p apps/frontend-e2e/tsconfig.json
bun run tsgo --ignoreConfig --noEmit --module preserve --target es2022 --skipLibCheck --strict --types bun,node runtime/local/scripts/delegation-next-runtime.ts
bun run lint:libsql-forbidden-references
git diff --check -- runtime/local/scripts/delegation-next-runtime.ts apps/frontend-e2e
```

Missing generated prerequisites were prepared using `bun run graphql-codegen`
in `packages/graphql-schema` and `apps/frontend`, plus direct
`bun run tsgo --build` for `packages/runtime/tsconfig.lib.json` and
`packages/frontend-endpoints/tsconfig.lib.json`.

## Boundaries And Limits

- The fixture installs the core agent's exported
  `Graphql.LocalDelegatedRealtime.layer`; there is no unresolved export name.
  It preserves the original upgrade request and connection parameters at the
  Yoga boundary and publishes real queue events into shared local event hubs.
- A genuine before screenshot was not feasible before repository edits: initial
  startup lacked generated schema types, then the fixed port 3398 was occupied
  by another worktree. That server was not stopped or reused. Port selection was
  added, and all acceptance evidence uses this worktree's fixture on 3498.
- Early attempts exposed probe locator/tab-selection issues and a development
  ChunkLoadError. The final combined run passed after selecting actual subscriber
  pages, installing observers before navigation, using accessible mobile controls,
  and selecting token metadata by name rather than list position.
- This browser probe does not deterministically test exact expiry, checker
  failures, role/owner/login-authority changes, feature disabling, or reconnect
  lineage. The final same-browser check covers the specific new event and actual
  document/binding transition, not exhaustive broader-human-cache exclusion.
- Mobile means a Chromium viewport and virtual passkey, not a physical device.
  No managed AppSync delivery, production build, or remote environment was tested.
- Browser sessions and the fixture were stopped. No Nx invocation, PR creation,
  remote mutation, or production deployment was performed.
