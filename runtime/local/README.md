# Process Focus Local Runtime

An installable local Process Focus stack containing the Dashboard,
authentication server, GraphQL API, job worker, and organisation import watcher.

## Run from an external organisation repository

Install the fixed release group and start it without Nx or a Process Focus
source checkout:

```bash
bun add @processfocus/cli@0.1.0-next.0 \
  @processfocus/runtime-local@0.1.0-next.0 \
  processfocus@0.1.0-next.0
bunx pf-runtime-local --org .
```

The launcher imports the organisation, starts every service, refreshes the
Dashboard JWT for the selected auth port, and prints the Dashboard URL. The
default ports are Dashboard `3000`, GraphQL `4000`, and auth `4020`; use
`--dashboard-port`, `--graphql-port`, and `--auth-port` to override them.

`PF_RUNTIME_ROOT` selects the directory for local runtime state and port files.
It defaults to the current directory. Set `INTERNAL_API_SECRET` to a stable
secret when signed file routes must survive restarts; otherwise the launcher
creates a process-local value.

## Monorepo development

`build` produces only the cacheable server bundle and Cedar/GraphQL resources in
`out-tsc/runtime`. Static validation can depend on it without starting support
servers or compiling the Dashboard. Its cache includes source dependencies and
transitive generated prerequisite outputs. It does not produce an installable
local runtime.

For the complete local distribution, including a fresh generic Dashboard build:

```bash
bun scripts/nx-quiet.ts run @processfocus/runtime-local:distribution-build
```

To assemble and inspect the publishable tarball:

```bash
bun scripts/nx-quiet.ts run @processfocus/runtime-local:pack-check
```

`pack-check` and `nx-release-publish` require `distribution-build`. CI's private
consumer verification also reaches it through `pack-check`. The separate CI
Dashboard job continues to build generic and hosted Next/OpenNext distributions
with `bash scripts/ci-frontend-build.sh`; use that command for explicit verification
of both distributions. The commit hook still runs affected static checks and
tests with their real prerequisites, without dependency-skipping flags.

Task-graph regression coverage and measurements are recorded in
[static validation investigation](../../docs/investigations/3113-static-validation.md).

## Services

- **GraphQL Server**: Development GraphQL API server (default port 4000)
- **PostgreSQL**: Alpine-based PostgreSQL database (port 5434)
- **Grafana OTEL LGTM**: Grafana with OpenTelemetry, Loki, Tempo, and Prometheus
  (ports 3030, 4317, 4318, 9090)

## Running all servers

Run all required servers with auto-reload:

```bash
PF_ORG=examples/demo bun scripts/nx-quiet.ts run @processfocus/runtime-local:serve
```

`serve` first runs one successful `pfcli import` for `PF_ORG`, then starts the
GraphQL server, authentication server, job worker and frontend dev server. If the
bootstrap import fails, dependent services do not start against stale imported
state. The direct service targets remain available when you intentionally want to
start one service by itself.

## Environment Variables

- `INTERNAL_API_SECRET` - shared secret for internal API communication between
  the frontend and GraphQL server (e.g., fetching Cedar policies during auth
  callback). **Required** - login will be disabled if not set.

## GraphQL Server

Running the server:

```bash
# Start in development mode (with auto-reload)
bun scripts/nx-quiet.ts run @processfocus/runtime-local:graphql-server:dev
```

By default the GraphQL server will be available at
**http://localhost:4000/graphql** if that port is available. It will
auto-select a different port if that port is in use.

Use a different port:

```sh
bun scripts/nx-quiet.ts run @processfocus/runtime-local:graphql-server:dev -- --port 4002
```

### Localhost Cookie Authentication

When running on localhost, access token cookies are port-suffixed to avoid
collisions between multiple local instances. For example, a Next.js server on
port 3001 sets a cookie named `access_token_3001`.

The GraphQL server derives the cookie name from the request's `Origin` header.
This works automatically when the frontend and GraphQL server share the same
origin. However, when using GraphiQL (which runs on the GraphQL server's port),
the origin mismatch means it looks for the wrong cookie name.

To fix this, set `NEXTJS_PORT` to tell the GraphQL server which cookie to use:

```sh
NEXTJS_PORT=3001 bun scripts/nx-quiet.ts run @processfocus/runtime-local:graphql-server:dev
```

Now GraphiQL will read `access_token_3001` instead of deriving it from its
own origin.

## Authentication server

For local development, bypass OAuth by setting the `PF_BYPASS_AUTH` env var to an existing user's email:

```bash
PF_BYPASS_AUTH=test@example.com bun scripts/nx-quiet.ts run @processfocus/runtime-local:authentication-server:dev
```

No changes to `project.json` are needed.

## Docker Services Usage

### Via Nx (recommended)

```bash
# Start all services
bun nx run local:up

# View logs
bun nx run local:logs

# Stop services (keeps data)
bun nx run local:down
```

### Direct docker compose

```bash
# Start all services
docker compose up -d

# View logs
docker compose logs -f

# Stop services (keeps data)
docker compose down

# Stop and remove volumes (fresh start)
docker compose down -v
```

## PostgreSQL

**Connection**:
```
Host: localhost
Port: 5434
Database: postgres
User: postgres
Password: postgres (or set PGPASSWORD env var)
```

**Connection string**:
```
postgresql://postgres:postgres@localhost:5434/postgres
```

**Custom password**:
```bash
PGPASSWORD=mypassword docker compose up -d
```

## Grafana

**Access**: http://localhost:3030

**OTLP endpoints**:
- gRPC: localhost:4317
- HTTP: localhost:4318

**Prometheus API**: http://localhost:9090

The Compose stack provisions the **Customer business activity** dashboard from
the repository, including its Loki-backed daily-active-user panel. A detailed
DAU dashboard is provisioned alongside it. Recreate the Grafana container after
changing dashboard JSON:

```bash
docker compose up -d --force-recreate grafana
```

Its checked-in Prometheus configuration accepts controlled samples up to 72
hours out of order so the opt-in business-metrics integration test can verify
adjacent UTC-day buckets deterministically.

Local customer-scope process metrics require `PF_AWS_ACCOUNT_ID`, `PF_PROJECT`,
and `PF_ENV`. Unclassified local activity is intentionally not recorded as
customer business activity. See
[`docs/observability/customer-process-starts.md`](../../docs/observability/customer-process-starts.md).

The local stack also provisions the customer DAU dashboard and Loki resource
label mapping. See [DAU setup and verification](../../docs/observability/customer-dau.md)
for the shared identity key, human activity capture, and opt-in export/query tests.

## Volumes

Data persists in Docker-managed volumes:
- `pf-local-postgres-data`: PostgreSQL data
- `pf-local-grafana-data`: Grafana data

**Inspect volumes**:
```bash
docker volume ls
docker volume inspect pf-local-postgres-data
```

**Storage location**: `/var/lib/docker/volumes/`
