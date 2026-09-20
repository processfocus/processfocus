# About

`@pf/auth-api` wires `@pf/openauth` into the Process Focus domain.

It is responsible for:
- employee login via OAuth providers and passkeys
- M2M `client_credentials` authentication
- provider and client resolution from database and env config
- mapping provider identities onto Process Focus session subjects
- optional Google Workspace OU-based invitation checks

Detailed flow documentation lives in [AUTHENTICATION-FLOW.md](./AUTHENTICATION-FLOW.md).

## Key Files

- `src/lib/create-authentication-server.ts` - main composition entrypoint
- `src/lib/provider-user-auth.ts` - provider user lookup, creation, invite checks
- `src/lib/google-directory.ts` - Google Workspace Directory API OU lookup
- `src/lib/passkey-auth.ts` - passkey login handling
- `src/lib/authentication-database.ts` - database service contract

## Runtime Integration

Runtimes call `createAuthenticationServer()` and use the returned runtime when
building the web handler.

Current runtime entrypoints:
- local: `runtime/local/src/authentication-server/authentication-server.ts`
- aws: `runtime/aws/src/lambdas/authentication-server.ts`

## Delegation Management

`AuthenticationConfig.delegatedAccess` does not enable management. Cedar alone
authorizes listing, issuance, rename, replacement, and revocation. Hydration
writes the flag alongside `inviteOnly` in each configured human provider only so
the anonymous login page can aggregate its presentation choice.

Both endpoints require an existing Provider User access JWT in
`Authorization: Bearer <token>` and return `Cache-Control: no-store`.

- `GET /delegations`: `200 { owner, canIssue, issuanceDeadline, delegations }`.
- `POST /delegations`: JSON `{ name, lifetimeDays: 1 | 7 | 14 }`, returning
  `201 { ...DelegationMetadata, secret }`. Names are trimmed, case-sensitive,
  and 1-128 characters. Unknown request fields are rejected.
- Metadata: `id`, `name`, `generationId`, `createdAt`, `expiresAt`,
  `status` (`active`, `expired`, `revoked`), nullable `revokedAt` and
  `lastUsedAt`. Dates are ISO UTC strings. Never-used credentials have no
  last-use timestamp, and expired records remain visible.
- Error bodies are `{ error }`: `400 invalid_request`, `401 invalid_token`,
  `403 delegation_unavailable` or `issuance_denied`, `409 name_conflict`,
  `405 method_not_allowed`, or `500 internal_error`.

Unexpected failures emit only `Unexpected delegation management failure` at
error level. Error messages, causes, and request payloads are deliberately
omitted because SQL errors can contain credential-bearing query parameters.

The owner and optional human-authentication evidence come only from a verified
issuer-signed access JWT. `humanAuthentication.authenticatedAt` is epoch
milliseconds; its `providerUserId` is the JWT's backing `userId`, not the
`provider_user` table's primary key. Cedar receives current database identity
and roles plus verified evidence; organisation Cedar policy owns listing and
issuance authorization, including any freshness requirement.

Runtime composition must provide `AuthorizationService` and `DelegationDatabase`.
`SqliteAuthenticationDatabaseLive` includes the latter. Missing services fail
closed. SQLite writes run in one caller-owned SQL transaction, with a unique
owner/active-name claim. Only a SHA-256 verifier of a server-generated 256-bit
secret is retained, alongside immutable issuance identity/deadline and history.
The initial creation response is the only disclosure. There is no public
replacement, extension, rename, administrator-read, or revocation endpoint in
this slice.

Integration coverage: `packages/sqlite-operations/test/delegation-management.test.ts`
uses real signed JWT verification, Cedar, migrated SQLite, persistent restart,
and concurrent independent database connections. Passkey ceremony/browser
verification belongs to the broader authentication and Dashboard journeys.

## Isolated Delegated Sessions

Local and AWS runtimes install `DelegationSessionServiceIsolated` independently
of anonymous login presentation. AWS requires no operator cutover, capability
header, or AppSync settings on Auth. Delivery settings remain on
GraphQL/job-worker.

- `GET /oauth/delegation/availability` authenticates the confidential frontend
  client and returns the aggregated presentation choice as
  `{ secretLoginEnabled }`, with no-store caching. The Dashboard hides secret
  login if the request or JSON fails. This result is not management availability
  or authorization.
- `POST /oauth/delegation` accepts JSON `{ secret: string }`, with no email or
  other fields, query parameters, or browser credential in the URL. It requires
  the confidential frontend client JWT in `Authorization: Bearer ...`, over HTTPS
  (HTTP is permitted only for loopback development). The Dashboard server, not
  the browser, owns this client credential.
- Success returns `{ access_token, refresh_token, expires_in, refresh_expires_in }`
  with `Cache-Control: no-store`. Both credentials are absolutely capped by the
  Secret Generation deadline. Normal and scoped refresh retain that deadline.
- `POST /oauth/delegation/session` accepts JSON `{ accessToken: string }` on the
  same confidential frontend client-JWT channel and returns `{ session }` with
  live `ProviderUserSession` facts and `Cache-Control: no-store`. It verifies the
  access token signature, issuer, frontend audience, access mode, provider-user
  type, raw delegation marker, schema, expiry and generation deadline before
  calling the live checker. It never mints credentials. Invalid/expired delegated
  tokens or lost authority return `401 { error: "invalid_token" }`; unavailable
  service returns `403 { error: "delegated_access_unavailable" }`. Body/client
  authentication failures remain generic and redacted. The body limit is 20 KiB
  and the access-token limit is 16 KiB. Live checks do not consume the secret-login
  attempt quota. Missing runtime wiring fails closed, just like secret exchange.
- Missing session service returns `403 delegated_access_unavailable`. Invalid
  credentials/storage failures return generic `400 invalid_grant`. Requests are
  limited to 1 KiB bodies and 30 attempts per minute per issuer instance, with
  `429 rate_limited` beyond that. Public deployment still needs fleet-wide abuse
  controls at its protected boundary.
- Secret redemption, live session checking, refresh, and delegated work do not
  read `delegatedAccess`; credential validity and Cedar `login` decide them.
- The subject remains `providerUser`, with the owner's normal identity fields
  and `delegation: { id, generationId, name, expiresAt }`. `expiresAt` is Unix
  milliseconds. Delegated sessions never carry `humanAuthentication`.
- Optional `delegationRoleSelection: string[]` tracks session role switching,
  outside the immutable delegation identity. When absent, roles follow all current
  owner assignments. When present, effective roles are its intersection with
  current assignments. It is not a secret-level permission scope or ceiling.
- `DelegationSessionService.check(session)` must run after signature, issuer,
  audience and JWT expiry verification at every accepting HTTP boundary. It
  returns `Effect<DelegatedSession, InvalidDelegationSession>` with live owner,
  roles and name, or fails closed. It checks owner existence,
  generation/delegation revocation and deletion, deadline, and Cedar login
  permission for Application `frontend`; anonymous-login presentation is not a
  session-validity input and no validity cache is used.
- `DelegationSessionService.exchange(secret)` verifies the SHA-256 digest against
  the issuing database and records a generation-attributed `login` event. Accepted
  usage updates generation last-use at most once per 30 seconds.
- Delegated issuance requires an explicit Cedar permit and retains immutable
  generation lineage. Dashboard-first CLI export preserves delegation identity
  and deadline. Assigned-role refresh supports URL-encoded `role:` scopes,
  never temporary permitted-role grants.
- Configuration writers, including hydration, must not revoke Delegations or
  generations when `delegatedAccess` changes or provider rows disappear. Explicit
  replacement and revocation remain irreversible, and toggling presentation must
  never revive those independently invalidated generations.

`test/delegation-session.test.ts` in `@pf/sqlite-operations` composes the real
authentication server, Cedar, migrated SQLite, signing keys and deterministic
Effect clocks. It tests exchange, issuance, refresh/role switching, expiry,
authority changes, storage errors, audit provenance and missing-service failures.

## Google Integrations

There are two separate Google integrations in this package.

### 1. Google Sign-In

User login uses Google OAuth 2.0 / OpenID Connect authorization code flow.

The auth server's current provider routes are:
- `/oauth/google/authorize`
- `/oauth/google/callback`

Google Cloud Console must allow the auth server callback URL, not the frontend
callback URL.

Use this redirect URI shape:
- `<AUTH_SERVER_URL>/oauth/google/callback`

In local development the auth server may fall back from port `4020` to another
free port. Check `.auth-port.json` before copying local redirect URIs into the
Google Cloud Console.

### 2. Google Workspace OU Lookup

When the Google provider config includes `invitedOrgUnits`, `serviceAccountKey`,
and `adminEmail`, auth-api also performs a Google Workspace Directory API lookup
after sign-in to determine the user's `orgUnitPath`.

This uses:
- a Google service account key
- domain-wide delegation
- impersonation of `adminEmail`
- scope `https://www.googleapis.com/auth/admin.directory.user.readonly`

Required setup:
- enable `Admin SDK API` in the Google Cloud project that owns the service account
- configure Workspace domain-wide delegation for that service account client ID
- grant the scope `https://www.googleapis.com/auth/admin.directory.user.readonly`
- ensure `adminEmail` is a Workspace admin who can read users and org units

Relevant provider config fields are defined in
`@pf/auth-config`:
- `invitedOrgUnits`
- `orgUnitAsRole`
- `serviceAccountKey`
- `adminEmail`

## Troubleshooting

- `Google Directory API error ... Failed to fetch user from Directory API`
  usually means the service account, Admin SDK API, domain-wide delegation, or
  impersonated admin permissions are wrong.
- `Authentication blocked: invite required` after that warning means the user
  had no explicit invite and the Google OU lookup did not produce a matching
  invite.
- If local Google sign-in suddenly starts failing after a restart, confirm the
  current auth server port in `.auth-port.json` still matches the redirect URI
  configured in Google Cloud Console.
