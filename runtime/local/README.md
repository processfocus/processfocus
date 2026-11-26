# Process Focus local runtime

Run an organisation on your machine with the Dashboard, authentication,
GraphQL API, background jobs, and an organisation import watcher.

## Run an organisation project

Install Bun and Node.js, then add the local runtime to your organisation project.
Use matching releases of the Process Focus packages:

```bash
bun add @processfocus/cli@next @processfocus/runtime-local@next processfocus@next
```

Add these project scripts:

```json
{
  "scripts": {
    "build": "pf-runtime-local --build --org .",
    "start": "pf-runtime-local --org ."
  }
}
```

Run `bun run build`, then `bun run start`. The build starts the supporting
services temporarily, so organisation credentials must be available during
both build and startup.

The Dashboard defaults to http://localhost:3000, GraphQL to port 4000, and
authentication to port 4020. Use `--dashboard-port`, `--graphql-port`, and
`--auth-port` in both scripts to choose other ports. Use `--no-dashboard` to
run backend services alone.

### Local state and rebuilding

Dashboard builds, keys, and caches live in `.processfocus/dashboard/`. Keep
`.processfocus/`, `dist/`, `db/`, and `files/` out of version control and
published packages. `PF_RUNTIME_ROOT` changes the local state root from the
current working directory.

Startup reuses the Dashboard build. Rebuild after changing runtime dependencies,
frontend plugins, branding, login configuration, or service ports; startup
reports when its build inputs no longer match. The import watcher updates
organisation data but does not rebuild the Dashboard. Changes to the generated
GraphQL schema also require a backend restart.

For local testing, `PF_BYPASS_AUTH` can name an existing user's email in
development mode. Production mode rejects this bypass. The launcher generates
an `INTERNAL_API_SECRET` when none is supplied; set a stable value if signed
file links need to survive restarts.

## Monorepo development

Use the tool versions in `mise.toml`. From the repository root:

```bash
PF_ORG=/path/to/organisation \
  bun scripts/nx-quiet.ts run @processfocus/runtime-local:serve
```

This imports the organisation and checks worker configuration before starting
the services, import watcher, and Dashboard development server.
Set a shared `INTERNAL_API_SECRET` for internal callbacks and signed file routes.

See [architecture](ARCHITECTURE.md) for how the services fit together and which
edits need a restart. Build and packaging targets are defined in
[`project.json`](project.json).

## Optional support services

The Compose stack provides Grafana and PostgreSQL for local development.
The default runtime uses a local Turso database; PostgreSQL is not required.

From the repository root:

```bash
docker compose -f runtime/local/docker-compose.yml up -d
docker compose -f runtime/local/docker-compose.yml logs -f
docker compose -f runtime/local/docker-compose.yml down
```

Grafana is available at http://localhost:3030, with OTLP on ports 4317 and
4318. PostgreSQL is available on port 5434. See
[`docker-compose.yml`](docker-compose.yml) for credentials and persistent volumes.
