# Delegated Realtime Frontend Verification

Issue: #2903. Frontend-only implementation; backend changes belong to the
parallel work in this worktree.

## Current Backend Contract

Since #3014, the Dashboard does not send an issuer capability header. Availability
reads the hydrated `delegatedAccess` org flag in local and AWS runtimes. Secret
exchange, session validation, and refresh retain their existing authentication
and live delegation checks. Realtime recipients remain bound to role authority
and exact JWT expiry, and collection initialization participates in credential
transitions. Old raw-user AWS clients must reload to subscribe.

## Contract

- Initial and recreated collection replication derive addresses with
  `@pf/auth-session/realtime-recipient`, using the JWT expiry in epoch seconds.
- Every actor, including humans, uses `/user/{opaqueRecipientId}` bound to role
  authority and JWT expiry. Missing expiry or recipients never
  fall back to the owner or collection-wide channel.
- AWS replication checks that the readable token's addressing facts match the
  server-provided session, then pins that token for requests and subscriptions.
  This is a consistency check, not JWT authorization or revocation enforcement.
- Scope changes invalidate pending initialization and recreation. Old callbacks
  cannot recreate replication under the new scope. Generation deadlines are
  part of persistent cache identity; token expiry is part of live replication
  identity.
- A stale signed token paired with updated live roles/name mounts only a session
  reissue boundary, not the authenticated Dashboard. The refresh endpoint checks
  that the reissued token matches current facts and returns its actual JWT expiry.
- Unchanged-authority refresh replaces registered token-bound replications in
  place, preserving TanStack collections, RxDB documents/checkpoints, and mounted
  forms. Timer-driven and proxy/RSC expiry updates are covered. The response must
  match both the current cache scope and the expected exact recipient.
- Before refresh can change cookies, initialization waits on a scoped credential
  transition. Validated credentials are published before renewing the registry
  snapshot. A collection registered during renewal uses that committed expiry,
  even while React still exposes the previous expiry. Initialization rechecks
  the transition after hashing; it never retries with an old authority fallback.
- Actual authority changes, missing facts, or failed transport replacement tear
  down the old view and re-enter server authentication. No old actor/generation
  refresh callback may replace a new scope's transport.
- Expiry hides authenticated client children; transport delivery and AWS pulls
  also check expiry. Replaced sockets and mismatched subscription IDs are ignored.

## Focused Checks

Run from `apps/frontend`, in separate Bun processes where module mocks are used:

```sh
bun test test/collection-session-reset.test.tsx
bun test test/realtime-recipient.test.ts test/appsync-session-transition.test.ts test/delegation-session.test.tsx test/session-cache-lifecycle.test.ts test/client-session.test.ts test/replication-registry.test.ts test/import-completed-query-invalidation.test.ts
bun test test/realtime-refresh-transition.test.tsx
bun test test/delegation-refresh.test.ts
bun test test/realtime-ssr-boundary.test.tsx
bun test test/session-reissue.test.tsx
bun test test/refresh-registration-race.test.tsx
bun test test/issuer-client-refresh.test.ts
bun test test/delegation-availability.test.ts
bun test test/delegation-login-route.test.ts
bun test test/delegation-live-session.test.ts
```

Result after refresh-race/protocol corrections: 74 tests passed across these
seventeen files.
Focused Biome checks and `git diff --check` passed.

An isolated strict TypeScript check of `lib/appsync-events/client.ts` passed,
confirming `isCurrent` and `expiresAt` belong to `AppSyncEventsClientConfig`, not
the subscribe wire message. A direct compiler-API probe using frontend options
without project-reference builds remains blocked by absent generated GraphQL
types and cascading errors. The only diagnostics in the selected changed source
files were the existing generated-GraphQL imports in the two replication factories.

The mounted collection test uses real React, TanStack DB, and in-memory RxDB,
with replication construction substituted to inspect addressing and authority
invalidation. Protocol tests run the real AppSync client against a fake browser
WebSocket. Refresh and expiry boundary tests mount React in JSDOM. These are not
visible browser journeys or managed AppSync delivery evidence.

The refresh-registration race test does not substitute either replication
factory or the token matcher: it runs real React, TanStack, RxDB, the AppSync
adapter/client, and shared recipient hashing. Only HTTP/WebSocket and runtime
configuration boundaries are simulated. It covers both the cookie-updated/
response-pending window and registration after the renewal snapshot, pulls a
document under the committed credentials, and preserves the original input
element and unsaved value. Issuer-client tests exercise the actual cached
OpenAuth client, preserving confidential authentication and role-selection form
encoding.

## Integrated Verification

After generating prerequisites through Nx and synchronizing project references,
the coordinating checks passed:

```sh
bun scripts/nx-quiet.ts affected -t lint,typecheck,test,knip --exclude='*,!@pf/runtime-aws,!@pf/auth-session,!@pf/auth-api,!@pf/graphql-api,!@pf/frontend,!@pf/graphql-e2e'
bun scripts/nx-quiet.ts affected -t lint,typecheck,test,knip --exclude='*,!@processfocus/cli'
```

These supersede the earlier source-only typecheck limitations above. The Nx
run also built the AWS runtime bundle and generated GraphQL prerequisites.
The libsql-reference guard and `git diff --check` passed.

Backend compositions exercise signed JWT verification, real Cedar, SQLite
delegation validity, all four collection publishers, process/Todo worker
adapters, issuer exchange/session/refresh, and capability-version rejection.
They cover continued human delivery alongside rejected delegations, replacement,
exact expiry, role/login/owner invalidation, stale records, and send retries.
AWS storage and transport boundaries are simulated, not the authorization
decision. CLI and E2E support now derive the same recipient; their local
WebSocket tests exercise actual subscription messages. The separate existing
human-only deployment-progress channel is preserved.

## Remaining Verification

- No production Next.js/OpenNext Dashboard build was run.
- No running Dashboard desktop/mobile journey was performed. Mounted JSDOM
  tests do not prove navigation, hydration, unsaved-form behavior, or multi-tab
  UX in a browser.
- No managed AppSync, DynamoDB registry, GraphQL/worker publication, or real
  Cedar/revocation round-trip was performed by this frontend task. The one-minute
  revocation bound is a backend delivery responsibility, not established here.
- Issuer client tests cover authenticated routine and role-selection refresh.
  These local tests do not establish managed AppSync delivery.
- Local GraphQL uses HttpOnly cookies and cannot perform the AWS readable-token
  consistency check. Its scope invalidation and request expiry guards are not
  proof of delegated local WebSocket authorization.
- No deployment, remote mutation, commit, tracker update, or PR change.
