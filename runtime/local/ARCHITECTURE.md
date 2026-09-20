# About

Local runtime architecture.

# Design

The local runtime is a small dev stack:

- GraphQL server
- authentication server
- job worker
- frontend `next dev` server via `@processfocus/runtime-local:serve`

There are two important sources of runtime state:

1. organisation code loaded directly from source by the GraphQL server and
   job worker via `OrganisationProviderFromPathDev`
2. imported database state plus generated artifacts such as
   `dist/graphql/org.graphql`, refreshed by `pfcli import`

That split is what drives most of the liveness story below.

# Liveness

Liveness is the ability of the local runtime to respond quickly to
changes a user or AI is making. In practice we want the shortest
possible save-to-observable-effect loop.

## Startup bootstrap

- The local runtime should perform one successful `pfcli import` before
  starting the GraphQL server, authentication server, job worker, or
  frontend dev server.
- This bootstrap import ensures database-backed process, step, flow and
  role rows exist before runtime services create GraphQL schemas, query
  workflows, resolve step roles, or start jobs.
- Bootstrap import is not the same decision as continuous import watch:
  startup ordering is accepted runtime hygiene, while watched import
  is a broad model-refresh mechanism.
- `@processfocus/runtime-local:serve` wires both pieces together: it depends on the
  deterministic `import:bootstrap` path through the bootstrapped services, then
  starts `import:watch` as a continuous post-bootstrap dependency.
- Between import and service startup, the uncached `job-worker:check` target
  builds and releases the actual worker dependency layers, including the
  organisation's custom job configuration, without starting queue consumers.
  A missing configuration value fails this target with a nonzero exit and
  restart guidance before any of the orchestrated services starts. For example,
  missing `EXAMPLE_XERO_CLIENT_SECRET` is reported as a startup failure instead of
  leaving an apparently healthy Dashboard with no working job worker.
- The check uses strict organisation loading; it cannot pass with the empty-org
  fallback used by the development watcher. It runs on every startup because
  credentials can change independently of source files. It checks dependency
  initialization, not external API credentials or ongoing worker health.

## Runtime and frontend code changes

- `runtime/local/project.json` runs the GraphQL server, authentication
  server and job worker with `bun --watch`, so edits to runtime code, or
  to imported organisation TypeScript, restart the affected process.
- The GraphQL server and job worker both use
  `OrganisationProviderFromPathDev`, which is resilient to temporary org
  load failures: if the org is broken we boot with an empty org, and the
  next save reloads the real one.
- `@processfocus/runtime-local:serve` runs the frontend with `next dev`, so
  frontend code changes use the normal Next/Turbopack fast-refresh loop.

## Process flow changes

- Process changes are only partly live from source alone.
- The executable org code is reloaded by `bun --watch`, but the local
  runtime also depends on imported database state and generated GraphQL
  schema in `dist/graphql/org.graphql`.
- Those generated/imported parts are refreshed by `pfcli import <org>`.
  `pfcli import` rebuilds the org bundle and schema, runs migrations and
  DB import, then calls the GraphQL server's
  `/internal/import-completed` endpoint.
- That callback emits process, execution and todo change events so
  connected frontends see imported data changes immediately after the
  import finishes.
- Important gap: the GraphQL schema is built when the GraphQL server
  starts and is not hot-reloaded when `dist/graphql/org.graphql`
  changes. So if a process edit changes the dynamic GraphQL shape, we
  still need a GraphQL server restart to pick it up.

In other words: today process-flow liveness is "run `pfcli import`, then
push updates", not full save-only hot reload.

## Import watch and targeted liveness

- `pfcli import --watch` is the continuous import loop for broad local
  model liveness. It is useful for keeping imported database rows and
  generated artifacts fresh, but it is not the only save-to-visible-UI
  mechanism for high-visibility surfaces.
- Direct watch mode runs an initial full import, then watches existing
  organisation source directories (`src`, `cedar`, `drizzle`) plus
  `drizzle.config.ts` when present. The local runtime starts watch mode with
  `--watch-skip-initial` after `import:bootstrap` has completed, so startup has
  exactly one deterministic bootstrap import before services begin.
- File events are debounced before starting another import. Source-only changes
  use the fast import-watch path that skips migrations and frontend JWT checks;
  migration-related changes under `drizzle/` or `drizzle.config.ts` run a full
  cycle.
- New subdirectories created after watch mode starts are not added to the watch
  set until watch mode is restarted.
- Each cycle logs start, success/failure, and total cycle time. Failed cycles
  are logged without exiting the watch loop, so a later valid save can recover.
- The key measured metric is save-to-visible-UI latency for high-visibility
  organisation edits, especially visual workflow changes and fields that
  appear on Todos.
- Target latency is under 2 seconds for common edits, with under 5 seconds
  as the upper acceptable bound. School-org measurements stayed under the
  5-second upper bound, but often landed around or above the 2-second target
  once debounce was included. Manual testing found full watched import useful
  but too slow to be the whole interactive editing contract.
- The workflow view is database-backed through `processWorkflow` and
  `WorkflowQueries`, so visual workflow liveness currently depends on
  imported `process`, `step`, `flow`, and role-responsibility rows plus the
  frontend process-update/refetch path.
- Mounted workflow pages listen to the local development import-completed event
  stream and refetch the visible workflow when the imported process path
  matches. This targeted invalidation is required because child-table workflow
  changes are not reliably visible through generic process collection events.
- Mounted Todo completion forms, process start forms, and workflow form previews
  invalidate active `formMetadata` queries after import completes. This keeps
  Todo-visible label/order metadata live without requiring navigation or view
  remounts.
- Embedded form entries and public completion forms are manifest/token-driven
  server-rendered surfaces. Their recovery path is still rebuild/import and
  reopen the public/embed URL so the server-rendered manifest or token payload
  is loaded again.
- Dynamic GraphQL schema-shape changes still require restarting the local
  GraphQL server after import, because the schema is built at server startup.
  Recovery path: let the watched import finish, restart the local runtime or
  GraphQL server, then reload the mounted frontend surface.

To opt out of the default watched import path, run the direct service targets
(`graphql-server:dev`, `authentication-server:dev`, `job-worker:dev`) and the
frontend manually instead of `@processfocus/runtime-local:serve`, or remove
`@processfocus/runtime-local:import:watch` from the `serve` dependency while debugging.

The resulting local liveness contract is hybrid: bootstrap import is mandatory,
watched import provides broad database-backed freshness, and targeted
invalidation/refetch paths are required for mounted surfaces where a developer
or agent expects immediate visual feedback.

## Authorisation changes

- Custom Cedar policy (`*.cedar`) edits are the closest thing to true
  hot reload today. When the org declares custom Cedar policies, the
  GraphQL server and job worker use `LocalCedarConfigHotReload` plus
  `PolicyWatcherService`, so policy changes are reparsed and hot-swapped
  in place without a process restart.
- Cedar schema (`*.cedarschema`) changes are not hot-reloaded. They are
  read at startup, so the GraphQL server and job worker must restart to
  pick them up.
- Frontend feature-permission checks are cached in Next with the
  `cedar-policies` tag.
- When the local GraphQL server successfully hot-swaps Cedar policies,
  it calls the frontend revalidation endpoint to invalidate that cache
  tag and the `/settings` path, so the next SSR render or navigation
  sees the new permission state without a frontend restart.
- Cedar schema changes still require a restart and do not trigger this
  revalidation path.
