# About

Test frontend functionality using Playwright with BDD (Cucumber-style feature files).

# Usage

## Run all tests

```bash
npx nx run @pf/frontend-e2e:e2e
```

## Run a single feature

Use `--grep` to filter by feature name (matches against the generated spec file path or test name):

```bash
# Run only authentication tests
npx nx run @pf/frontend-e2e:e2e --grep authentication

# Run only logout tests
npx nx run @pf/frontend-e2e:e2e --grep logout
```

## Run in UI mode

```bash
npx nx run @pf/frontend-e2e:e2e --ui
```

## Run in headed mode (see browser)

```bash
npx nx run @pf/frontend-e2e:e2e --headed
```

## Run against AWS

```bash
BASE_URL=https://dashboard.example.com \
  CI_PIPELINE_SECRET=some-secret \
  npx nx run @pf/frontend-e2e:e2e --ui
```

## Run an alternate feature set

Use `FRONTEND_E2E_FEATURES` to point Playwright-BDD at a different feature
glob (for example org-specific features outside this app):

```bash
FRONTEND_E2E_FEATURES=/path/to/your-org/e2e/frontend/features/**/*.feature \
  npx nx run @pf/frontend-e2e:e2e -- --grep @demo
```

## Run specific browser only

```bash
npx nx run @pf/frontend-e2e:e2e --project chromium
```

## Debug a test

```bash
npx nx run @pf/frontend-e2e:e2e --debug --grep authentication
```

# Completion Backlog Regression

The `@todo-completion` journey has a three-minute scenario budget and a
one-minute queue-acquisition budget. Authentication, asynchronous Todo creation,
metadata, validation, completion, and persisted refresh share the scenario
deadline. A render wait alone does not extend it.

An opt-in Linux regression runs this same journey against real local services,
with 33 seconds of setup latency and the actual worker paused for 35 seconds
when the browser submits the start mutation. It does not mock HTML or GraphQL
responses. The After hook attempts to resume the worker on success or test
failure and reports any signal errors at the test boundary. It checks that
injection matched and the 35-second timed resume completed only when the scenario
otherwise passed, preserving the original scenario failure otherwise.

Start a disposable demo runtime in a separate terminal, using an unused port:

```bash
FRONTEND_PORT=3616 CI_PIPELINE_SECRET=local-completion-regression \
  GOOGLE_CLIENT_ID=local-google GOOGLE_CLIENT_SECRET=local-google \
  bun cli/pfcli/src/run-temp-org.ts examples/demo --copy -- \
  bun scripts/nx-quiet.ts run @processfocus/runtime-local:serve
```

Find that runtime's `bun --watch runtime/local/src/job-worker/job-worker.ts`
PID with `pgrep -af 'runtime/local/src/job-worker/job-worker.ts'`. Supply it as
`WORKER_PID` below. The hook rejects a worker outside this worktree, a
non-disposable organisation, or a Dashboard port that does not match the worker.
Run only this scenario with one worker; do not share the disposable runtime.

```bash
BASE_URL=http://localhost:3616 CI_PIPELINE_SECRET=local-completion-regression \
  FRONTEND_E2E_COMPLETION_WORKER_PID="$WORKER_PID" \
  FRONTEND_E2E_BROWSERS=chromium \
  bun scripts/nx-quiet.ts run @pf/frontend-e2e:e2e \
  --grep 'Authenticated state-aware todo completion' --workers=1 --retries=0
```

Omit `FRONTEND_E2E_COMPLETION_WORKER_PID` for the ordinary journey. Stop the
disposable runtime afterward. If the test worker is forcibly killed before
cleanup, resume the runtime worker with `kill -CONT "$WORKER_PID"` before stopping
it. This regression proves bounded backlog handling, not the cause or latency
of any remote queue backlog.

# Genuine Passkey Delegation Journey

`src/features-delegated-access/delegated-access.feature` is an opt-in local
journey, separate from the default M2M-authenticated suite. Start a freshly
imported disposable demo organisation under the system temporary directory,
with `AuthenticationConfig.delegatedAccess: true` showing anonymous secret login
and the passkey `origin` matching its localhost Dashboard URL. Cedar, not that
flag, authorizes the Administrator journey. Keep its file-backed `db/pf.db` and
runtime alive for the test.

```bash
BASE_URL=http://localhost:3197 \
FRONTEND_E2E_DISPOSABLE_ORG=/tmp/path-to-disposable-demo \
FRONTEND_E2E_FEATURES='./src/features-delegated-access/*.feature' \
FRONTEND_E2E_BROWSERS=chromium \
bun scripts/nx-quiet.ts run @pf/frontend-e2e:e2e --retries=0
```

The journey uses the local `pfcli invitation registration-link` command for the
demo Administrator `settings-e2e@example.com`, registers a resident user-verifying
CTAP2.1 virtual passkey, then submits token creation through the real Dashboard.
The demo organisation's explicit human Administrator grant allows creation and
replacement without any additional ceremony. It verifies all three lifetimes, one-time clipboard
disclosure, desktop/mobile layout, and metadata
after reload. It then registers the ordinary `employee-2@example.com`, verifies
that **Act on behalf** and creation controls are absent, and checks direct list and
create API denials. It never injects M2M authentication cookies. Use a new disposable
organisation for each run; alternatively select another pending Invitation
with `FRONTEND_E2E_INVITATION_EMAIL`. The bootstrap consumes that Invitation.

The journey configuration disables trace, screenshot, and video recording and
sets Playwright's `PLAYWRIGHT_NO_COPY_PROMPT=1` to suppress automatic failure
accessibility snapshots. Guards reject unsafe artifact overrides before
Invitation bootstrap and before issuance. This does not depend on command-line
flags or deleting artifacts after a failure.

Clipboard equality is checked entirely inside the browser and returns only a
boolean. The secret is never pasted into the name field. A `finally` block clears
the clipboard and dismisses the disclosure even when the comparison fails.

Run the artifact regression independently of a real organisation:

```bash
bun apps/frontend-e2e/scripts/verify-delegation-artifacts.ts
```

It runs an intentionally failing BDD probe with a synthetic secret, checks
cleanup after a clipboard mismatch, and leaves the synthetic secret visible
at the final failure. The verifier checks reporter output and every output file
for disclosure and rejects page snapshots, traces, screenshots, or video. It
uses the same journey configuration and clipboard helper, and checks that unsafe
artifact options are rejected. Temporary probe outputs are cleaned automatically.

# Isolated Next Delegation Probe

`bun runtime/local/scripts/delegation-next-runtime.ts` starts an isolated
SQLite/auth/Cedar/GraphQL composition and the real Next Dashboard at
`http://localhost:3398/login`. It uses an in-memory test owner and generation,
the issuer's real signing keys, and the protected exchange/live-session
endpoints. Yoga, the generated two-form `Delegated Review` model, and the
SQLite queue worker share the authentication database. This disposable fixture
installs `LocalDelegatedRealtime.layer` alongside the isolated session verifier.
It does not configure any public runtime or remote environment.

Set `DELEGATION_PROBE_PORT=3498` (or another free local port) if the default
3398 belongs to another worktree. The issuer, passkey origin, callbacks, private
handoff, and Next child all use the selected port.

The probe can verify secret exchange, proxy/SSR acceptance, refresh, assigned
`/Tester` role switching, CLI-export rejection, and logout. Its synthetic secret
is `pfds_` followed by 43 `a` characters, valid only in this disposable process.
Do not use real credentials or record credential-bearing browser/network state.

For the presentation/authorization matrix, start the fixture with
`DELEGATION_PROBE_ISSUANCE=true` and use a named `agent-browser` session. The
private `browser-handoff.json` supplies the frontend URL, control endpoint, and
control token. Its `secret-login-presentation` operation toggles only the
hydrated provider presentation value; `presentation-policy` independently grants
or removes same-owner listing and issuance for the fixture Delegation. Verify all
four combinations: the login page follows only `visible`, the profile's **Act on
behalf** entry follows only the policy, and creation follows issuance policy.
Do not attach the handoff, browser storage, network capture, or any screenshot
that contains a disclosed secret.

For an ordinary-work browser round-trip, log in with the synthetic secret, open
Processes, start `Delegated Review`, enter a request, and submit. Open My To-Dos
to see the worker-created `Review request`. Complete it with a
decision, then open Executions and select Completed. Both timeline
entries must identify the owner via `next-probe-agent`. The same execution detail
is available on mobile by selecting its card.

The fixture uses the local runtime's Bun/graphql-ws Yoga adapter pattern,
including upgrade cookies, connection parameters and serialized context setup.
The real flow, Todo-event, process-event and execution-event handlers drain the
SQLite queues serially. Since worker and GraphQL share a process, event publishers
emit into the same local hubs directly; no callback authorization bypass or
business-data polling is added. The shell's "Real time sync active" badge alone
is not evidence of delivery. No mock business responses are installed.

Stop with SIGINT or SIGTERM: the fixture stops Next, the worker loop, GraphQL,
and auth, disposes SQLite, and removes generated temporary files. The initial
owner/generation is seeded for the ordinary-work probe. A separate pending
Invitation supports the joined genuine-passkey lifecycle journey below.

## Joined Owner/Agent Lifecycle

See the [executed local realtime evidence](./delegation-realtime-evidence.md)
for the #2902 latest 32-check desktop/mobile pass with cessation HTTP/DOM
assertions, observed same-browser re-entry,
resolved header blocker, and explicit verification limits.

The runtime prints the path (not contents) of a mode-0600
`/tmp/pf-delegation-next-*/browser-handoff.json`. This private file contains a
Registration Link for `lifecycle-owner@example.test` and local verifier inputs.
Never attach it, print it, or preserve browser auth state or network recordings.

With the fixture running, execute the standalone agent-browser probe:

```bash
bun apps/frontend-e2e/scripts/delegation-lifecycle-probe.ts \
  /tmp/pf-delegation-next-EXAMPLE/browser-handoff.json \
  /tmp/ready-for-agent/pr-attachments/WORK-ITEM
```

An optional final argument `desktop` or `mobile` selects a focused run; the
default `both` runs both viewports. Use separate evidence subdirectories for
retries so a failed run cannot overwrite the successful check report.

Use a fresh fixture for every run because genuine passkey registration consumes
the Invitation. The script drives visible interactions and screenshots through
`agent-browser`; Playwright CDP is used only to install the same resident,
user-verifying CTAP2.1 authenticator as the BDD journey, read issued HTTP-only
cookies in memory, and passively observe actual Dashboard WebSocket frames.
Only business IDs are retained from delivery frames. It does not inject owner
credentials, create substitute subscriptions, or mock business APIs.

At 1440x1000 and 390x844, independent owner and agent sessions verify rename,
one-time replacement disclosure, 7/14-day replacement durations, old/new secret
login, revocation, and metadata after reload. Previously issued credentials are
replayed against real Yoga reads/submissions, protected Next SSR, issuer refresh,
and Dashboard refresh. The API must return the live-generation denial, not just
an arbitrary GraphQL error. Already-accepted work and delegated initiation
attribution remain visible after revocation. Shared idempotent cleanup closes
both browser sessions on completion, failure, SIGINT, or SIGTERM, draining any
in-flight browser command first. Separately stop the runtime using SIGINT/SIGTERM.

The owner also keeps a separate authorized My To-Dos tab open. Before each
replacement/revocation the probe verifies a newly worker-created Todo reaches
both actual browser WebSockets and renders in the agent page without navigation
or reload. The agent performs ordinary start-form and Todo-completion UI work.
After each owner change, retained HTTP/refresh credentials are checked promptly;
both subscriber pages remain open until the one-minute propagation bound, when
the human triggers new ordinary work. The resulting worker event must reach the
human's original subscriber but never the invalid agent over WebSocket or HTTP
pull (matched by execution ID). After a further two-second delivery observation,
the matching human event's Todo ID must appear in a human action link and be
absent from agent DOM links, rather than relying on repeated fixture titles.
This is an end-of-window DOM assertion, not continuous DOM monitoring. Navigation counters
ensure the cessation proof did not replace the original subscriber documents.
Allow several minutes for both viewports: the one-minute waits are deliberate,
not network polling or a test of connection flags.

The extended probe also opens a delegated tab in the owner's browser and then
uses real server logout and the owner's genuine passkey login in another tab.
After revocation, the new worker event must not enter the original delegated
binding or an unchanged document via WebSocket or HTTP pull. A deliberate reload
through the human auth boundary is allowed only with a changed document time
origin, the independently confirmed human binding, and delivery/request timestamps
after that boundary. Remaining delegated without receiving the new event is also
a passing outcome; neither re-entry nor delivery to this tab is required.
Both viewports recorded re-entry and WebSocket delivery (no HTTP delivery) in the
final run's diagnostics. These are observations, not positive delivery assertions
for this tab; the probe does not require it to become human or stay delegated forever.
The independent human subscriber is established after the intentional cookie
transitions and before its no-reload revocation baseline.

Screenshots are captured only after disclosure dismissal and password clearing.
Secret-bearing command input goes through stdin, never command-line arguments;
raw browser output and upstream errors are not reported. The output directory
contains only screenshots and a timestamped, secret-free JSON check report.
This local browser probe does not replace deterministic verifier/persistence/Cedar
tests for exact expiry, checker failures, owner/role/permission changes, feature
disabling, or reconnect lineage. It does not claim physical mobile passkeys,
managed AppSync delivery, or public activation acceptance by itself.

In a clean worktree, prepare the frontend's GraphQL codegen and published runtime
build prerequisites before starting Next. Use the repository Nx wrapper when
no other agent is running Nx. If a coordinator owns Nx, direct equivalents are:

```bash
# From apps/frontend:
bun run graphql-codegen
# From the repository root:
bun run tsgo --build packages/runtime/tsconfig.lib.json
```

## Cross-Owner Administration

The same isolated runtime and agent-browser driver have an administration mode:

```bash
DELEGATION_PROBE_PORT=3490 bun runtime/local/scripts/delegation-next-runtime.ts
# In another terminal, use the private handoff path printed by that runtime:
bun apps/frontend-e2e/scripts/delegation-lifecycle-probe.ts \
  /tmp/pf-delegation-next-EXAMPLE/browser-handoff.json \
  /tmp/ready-for-agent/pr-attachments/WORK-ITEM/FRESH-RUN --administration
```

Use a fresh runtime and evidence subdirectory for every attempt, preserving
older reports rather than overwriting them. The probe rejects an existing evidence
directory (even an empty one) before starting browsers. Stop any leftover fixture from this
worktree first: a different port does not avoid Next's development-directory lock.
No Nx targets are started by these
commands; coordinate prerequisite builds as described above. The configurable
loopback frontend port avoids colliding with another agent's runtime.

The fixture includes a separate Administrator Invitation and an explicit Cedar
permit for that administrator's Delegations to list metadata and revoke. The
journey registers both humans through genuine independent virtual passkeys,
then uses separate agent, delegated-administrator, and unrelated-survivor browser
sessions. Administration mode also grants human Administrators `administerUsers`
in the disposable policy file so the journey can follow the selected-user link
from the real user editor. Delegations receive no general user-editing grant.
It exercises the selected-user token route, legacy `ownerUserId` redirects,
personal empty states and keyboard creation, real clipboard copy, policy-derived controls,
direct HTTP authorization negatives, human and delegated administrator revocation,
retained API/browser/refresh credential rejection, unaffected sessions, and
persisted actor/owner/generation attribution at 1440x1000 and 390x844. Each selected
viewport also finishes with an own-token create, rename, replace, revoke, and
secret-login round-trip. Pass `mobile` or `desktop` after `--administration` to
run only that viewport. Route checks wait for visible content because redirect
transitions can retain hidden Activity content in the DOM.
For each human/delegated administrator target, before and after revocation, the
visible card's status and its expiry/last-use `<time datetime>` values must match
the current list API. Stable metadata attributes identify the token; dates are
human-readable. Personal management omits visible internal identifiers; administrator
cards display Delegation ID and Secret Generation. API reads bracket the DOM
observation; changed timestamps or a lagging UI trigger a bounded retry, not a
comparison against stale fixture timestamps or a timestamp tolerance.
Rejected GraphQL reads and submissions must have absent/null `data`, not errors
alongside protected data. Idle own-expiry and own-revocation must remove visible
owner metadata and mutation controls without operator/probe navigation or reload.
An automatic login redirect is a valid outcome; it is still navigation.

A private, random-bearer-authenticated loopback fixture control can read lifecycle
history and shorten an administrator generation's real storage deadline to at
most sixty seconds. It cannot extend a deadline. The expiry journey exchanges
the secret after shortening the deadline, verifies a positive metadata control,
waits for that deadline, checks the resulting credentials are rejected, and
replaces the expired token through the human owner's browser.
This is disposable fixture behavior, not a shipped management API or an audit UI.

Only `administration-results.json`, safe screenshots, and (on failure)
`administration-failure.json` are reportable. Registration Links, cookies, JWTs,
secrets, handoff files, and raw browser output must not be attached. The probe
captures no before image. A script's assertions describe intended coverage;
only completed checks in the actual run report establish verified coverage.

The [executed administration verification record](../../docs/authentication/delegation-administration-verification.md)
records the latest 30-check desktop/mobile pass, including eight target-scoped
DOM/API metadata comparisons and idle invalidation, in
`2026-09-08-metadata-review-01` (2026-09-07 21:27:41 to 21:37:57 UTC).
Desktop idle expiry cleared in 1,749 ms; mobile idle revocation cleared in
16,933 ms. Earlier runs reproduced and verified the proxy Server Action redirect
fix; historical artifacts in the parent directory are not current acceptance.
See the record for the minimal proxy fix, exact timings, artifacts, and limits.
Allow at least fifteen minutes for a full probe command and cleanup.

# Structure

- `src/features/*.feature` - BDD feature files (Gherkin syntax)
- `src/steps/*.ts` - Step definitions
- `.features-gen/` - Auto-generated Playwright specs from features (do not edit)

## Production instant-navigation regression tests

See [the shared validation runbook](../../docs/frontend/instant-navigation.md)
for local production builds, `instantUI`, form-plugin verification, and the
boundary between these tests and destination-specific navigation coverage.
