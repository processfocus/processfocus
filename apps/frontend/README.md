# About

Generic Process Focus **Dashboard**. This app is not the customer-facing
**Console** (`cloud/org/console`) and not the private **Backend** deployment
of this same Dashboard.

See [Dashboard distributions](../../docs/frontend/dashboard-distributions.md)
for Nx targets and the accepted organisation-owned plugin model.

# Build Preparation

[ADR 0023](../../docs/adr/0023-organisation-artifacts-own-plugin-implementations.md)
defines the accepted plugin architecture: `pfcli build` emits self-contained,
hashed browser plugin files and their versioned manifest in the organisation
artifact. The per-environment OpenNext build generates literal imports from
those files. Plugin implementations are organisation dependencies; the
Dashboard owns only the host contract.

`pfcli build <org>` produces the frontend inputs consumed by this app:

- `dist/frontend-manifest.json` contains embed-route metadata and categorized
  plugin activation/configuration.
- `dist/browser-plugins.json` identifies each migrated browser plugin and its
  host-interface version, content-addressed path, and SHA-256 integrity.
- `dist/browser-plugins/*.js` contains self-contained organisation-owned
  browser implementations. React and Next remain host-provided peers.
- `dist/browser-plugins/*.css` contains optional integrity-checked build
  preparation stylesheets whose Tailwind sources point only at emitted browser
  bundles.

`@pf/frontend:prepare-build-inputs` validates browser identities, paths, files,
integrity, and host-interface compatibility before staging the bundles inside
the Next workspace and generating bundle-visible literal imports. PostHog,
Google Drive, and the private cloud-org plugins use this path and are absent
from Dashboard/runtime package dependencies. Every selected browser plugin must
have an artifact entry; missing implementations fail the build.

For the shared org-scoped PostHog path, an org build that opts into PostHog
must have `POSTHOG_PROJECT_API_KEY` and `POSTHOG_HOST` in its build environment.
If those public browser config values are missing, local `pfcli build <org>`
fails before the frontend build starts.

Keep those public manifest values separate from the frontend server/build env
used by Next.js itself. `GRAPHQL_ENDPOINT`, `JWKS_URI`, `FRONTEND_JWT_TOKEN`,
`PF_ORG`, and `PF_ENV` still control how the frontend build talks to auth and
GraphQL during prerendering.

# Debugging

## Local runtime

This will use the local runtime and

```sh
GRAPHQL_ENDPOINT=http://localhost:4001/graphql bun scripts/nx-quiet.ts run @pf/frontend:dev
```

## Local graphql server and AppSync Events

Using local graphql instance, but using AppSync Events:
```sh
GRAPHQL_ENDPOINT=http://localhost:4000/graphql \
  APPSYNC_EVENTS_HTTP_HOST=example.appsync-api.ap-southeast-2.amazonaws.com \
  NEXT_PUBLIC_APPSYNC_EVENTS_REALTIME_URL=wss://example.appsync-realtime-api.ap-southeast-2.amazonaws.com/event/realtime \
  OAUTH_ISSUER_URL=https://auth.example.com \
  bun scripts/nx-quiet.ts run @pf/frontend:dev
```
