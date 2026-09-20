# pfcli

Process Focus CLI Tool — scaffold, build, and manage business process organisations.

## Overview

`pfcli` is the command-line interface for the Process Focus business process modeling system. It helps you:

- Scaffold new organisation directories with working templates
- Build and bundle organisation code for deployment
- Destroy hosted project environments through the existing Backend process
- Import organisation configurations to the database
- Run system and custom database migrations
- Inspect custom-domain certificate status and required DNS records
- Run browser-based CLI authentication
- Open a short-lived Database Shell for hosted environment investigation
- Download hosted environment databases as local SQLite databases
- Serve agent-oriented runtime skill guidance for the installed CLI version

## Commands

### `init`

Initialise a new organisation directory with template files, generate a
`package.json` using the released `processfocus` SDK, install dependencies, then
import it so `db/pf.db` and the frontend JWT exist immediately.

```bash
pfcli init <org-path> --email <admin-email> --identity-provider <name> [--identity-provider <name> ...]
```

**Arguments:**
- `org-path` — Path to the organisation directory to initialise (supports `PF_ORG` env var)

**Options:**
- `--email` — Admin email used for the scaffolded invitation and Cedar policy (required)
- `--identity-provider` — Identity provider to scaffold; repeat for multiple providers (required, at least one)

**Example:**
```bash
pfcli init ./my-org --email admin@example.com --identity-provider google --identity-provider github
PF_ORG=./my-org pfcli init --email admin@example.com --identity-provider google
```

Creates the following structure:
```
my-org/
├── package.json        # Generated org package metadata and npm dependencies
├── node_modules/       # Normal package-manager installation
├── db/
│   └── pf.db           # Created and seeded by init via import
├── src/
│   ├── index.ts        # Entry point re-export
│   ├── org.ts          # Org definition (processes, roles, auth, invitations)
│   └── todo.ts         # Sample Todo process
└── cedar/
    └── custom.cedar    # Cedar authorization policies
```

### `build`

Build organisation artifacts (bundled JS, GraphQL schema, Cedar policies).

```bash
pfcli build <org-path> [options]
```

**Arguments:**
- `org-path` — Path to the organisation directory

**Options:**
- `--output, -o` — Output directory for build artifacts (default: `dist`)

**Example:**
```bash
pfcli build ./my-org
pfcli build ./my-org --output ./build
```

Outputs:
- `dist/org.js` — Bundled organisation code from `src/index.ts`, including `dbImport`
- `dist/graphql/org.graphql` — Generated GraphQL schema
- `dist/cedar/` — Copied Cedar policy files

`dist/org.js` is the single import/runtime artifact. `pfcli import` uses the
built bundle's `dbImport` entrypoint rather than loading `src/index.ts` directly.

### `deploy`

Build the org, upload the resulting `dist` artifact, and start the deploy process.

```bash
pfcli deploy <org-path> --project <project-number> --env <environment-name>
```

**Arguments:**
- `org-path` — Path to the organisation directory

**Options:**
- `--project` — Project number to deploy (internal project ID also accepted)
- `--env` — Environment name to deploy to (internal environment ID also accepted). Environment names are unique within a project, not just within a stage.
- `--no-wait` — Return after starting the deployment instead of waiting for completion

**Behavior:**
- Requires valid CLI credentials in `~/.config/pf/credentials.json`
- If missing or expired, command exits with: `Run "pfcli auth login"`
- Runs `pfcli build <org-path>` first
- Zips `<org-path>/dist`
- Requests upload URL via GraphQL `requestUploadUrl`
- Uploads zip to returned `uploadUrl`
- Starts deploy via `startOperationsDeploy`
- Waits for execution completion by default and prints concise execution updates

### `destroy`

Destroy a hosted project environment by starting the existing Backend process.
There is no organisation path or artifact upload.

```bash
pfcli destroy --project <project-number> --env <environment-name> --yes
pfcli destroy --project <project-number> --env <environment-name> --yes --no-wait
```

**Options:**
- `--project` — Project number to destroy from (internal project ID also accepted)
- `--env` — Environment name to destroy (internal environment ID also accepted)
- `--yes` — Mandatory non-interactive confirmation
- `--no-wait` — Return after starting destruction instead of waiting for completion

**Behavior:**
- Requires valid credentials from `pfcli auth login`
- Refuses to start unless `--yes` is present and identifies the target project and environment in the error
- Checks the environment name against the project's known environments before starting
- Starts the existing `/operations/destroy-environment` Backend process via `startOperationsDestroyEnvironment`; the CLI does not delete stacks itself
- The Backend process deletes the environment's AWS stacks and environment record
- Waits up to 45 minutes for execution completion by default and surfaces Backend failure details
- Prints only the execution ID when starting; it does not print credentials, signed URLs, or AWS account IDs

### `invitation registration-link`

Mint or rotate a Registration Link locally or in a remote customer environment. Pending Invitations use first-admin passkey bootstrap; `--rotate` can also issue a fresh Passkey Recovery Link for an existing account associated with an accepted or legacy-closed Invitation.

```bash
# Local database
pfcli invitation registration-link [org-path] --email <invited-email>
pfcli invitation registration-link [org-path] --email <invited-email> --rotate

# Remote customer environment
pfcli invitation registration-link --project <project-number> --env <environment-name> --email <invited-email>
pfcli invitation registration-link --project <project-number> --env <environment-name> --email <invited-email> --rotate
```

**Arguments:**
- `org-path` — Optional path to the organisation directory (local mode only; may come from `PF_ORG`)

**Options:**
- `--project` — Project number (internal project ID also accepted; remote mode)
- `--env` — Environment name (internal environment ID also accepted; remote mode)
- `--email` — Email of the pending Invitation
- `--rotate` — Replace an active or expired pending Registration Link, or issue a fresh single-use Passkey Recovery Link for an existing active account

**Behavior:**
- Local mode resolves its database from `SQLITE_DATABASE_PATH`, `org-path`, or `PF_ORG`
- Local URLs use `FRONTEND_BASE_URL`, `BASE_URL`, or `NEXT_PUBLIC_FRONTEND_URL`, falling back to `http://localhost:3000`
- Remote mode requires `--project` and `--env` together and valid CLI credentials from `pfcli auth login`
- Remote mode does not accept `org-path`
- Identifies the Invitation by Normalized Email (trim + lowercase)
- Prints the Registration Link URL once to stdout on success
- Does not print the URL on failure
- A second generate without `--rotate` fails while a live link exists
- Recovery preserves current roles, existing passkeys, and Invitation history. It refuses deleted Invitations, inactive accounts, accounts without current roles, and disabled passkey providers.
- Revoked pending links cannot be rotated. Restoring their access requires an explicit administrative action.
- Remote recovery additionally requires `recoverProviderUser` permission (initially Cloud Backend Administrators only), alongside user administration and project/environment access.
- Recovery links expire after 24 hours; browser sessions last at most ten minutes. Rotation invalidates all earlier recovery links and sessions for the account.
- Does not log the URL

CLI tests cover issuing and exchanging a local Registration Link through the
authentication database. Completing passkey registration and signing in remain
a browser acceptance step with a virtual authenticator.

### `db upload`

Upload a local SQLite database artifact through a signed document-store URL and wait for the backend apply flow to finish.

```bash
pfcli db upload --project <project-number> --env <environment-name> [--mode data-copy|exact-restore] <sqlite-file>
```

**Arguments:**
- `sqlite-file` — Local SQLite database file to upload

**Options:**
- `--project` — Project number to upload to (internal project ID also accepted)
- `--env` — Environment name to upload to (internal environment ID also accepted)
- `--mode` — Upload semantics. Defaults to `data-copy`; use `exact-restore` only when the uploaded authentication state must replace the target environment's state

**Behavior:**
- Validates the local file exists, is a regular non-empty SQLite database file, and is readable before requesting an upload URL
- Uploads database bytes only through the signed document-store URL, not through GraphQL
- Starts the backend database apply flow and waits for completion; there is no `--no-wait` option
- `data-copy` preserves the target environment's signing keys, encryption keys, legacy signing keys, and stored frontend JWT while discarding all imported OAuth sessions and other OpenAuth storage
- `exact-restore` applies all uploaded database state, including OpenAuth keys and sessions
- Both modes create and validate a recovery snapshot before changing the uploaded candidate or the Active Environment Database
- For SQLite-engine (`libsql`) targets, requires `journal_mode=WAL` and keeps the existing Turso file-seed cutover
- For TursoDB (`tursodb`) targets, accepts the `journal_mode=delete` artifact produced by `db download`, replays a logical SQL dump into an empty TursoDB candidate through the Console's Turso Cloud layer, filters Turso-owned `__turso_internal_*` objects, and preserves AUTOINCREMENT continuity
- Prints concise JSON status lines with the local input path, byte size, document store path, operation ID, file ID, execution ID, and final `APPLIED` result
- Backend failures after a recovery snapshot is created include the recovery snapshot file ID for manual recovery
- Does not print signed URLs, Turso tokens, SSM parameter values, direct database credentials, AWS credentials, or raw secrets

### `db download`

Download a hosted environment database to a local SQLite database. The CLI asks the console GraphQL API for a short-lived direct download session and authoritative engine metadata, then selects the engine-specific transfer mechanism.

```bash
pfcli db download --project <project-number> --env <environment-name> [--output ./backup.sqlite]
```

**Options:**
- `--project` — Project number to download from (internal project ID also accepted)
- `--env` — Environment name to download from (internal environment ID also accepted)
- `--output` — Output path for the downloaded database. If omitted, `pfcli` writes a timestamped `pfcli-db-<project>-<env>-<timestamp>.sqlite` path in the current directory

**Behavior and boundaries:**
- Calls the console GraphQL download-session API using the Process Focus CLI login; GraphQL returns session metadata and short-lived Turso credentials, not database bytes
- Uses Turso Sync unchanged for SQLite-engine (`libsql`) databases; their output is reusable Turso Sync local state and sidecar files may appear beside it
- For TursoDB (`tursodb`), streams the authenticated HTTPS logical dump, removes Turso-owned `__turso_internal_*` objects, replays it into an ordinary SQLite file, and runs `PRAGMA integrity_check` plus `PRAGMA foreign_key_check`
- For TursoDB, builds in owner-private temporary files and atomically replaces `--output` only after validation. An existing output is replaced by a complete logical snapshot, not incrementally updated
- Waits for the engine-specific transfer to complete; there is no `--no-wait` option
- Prints concise JSON status lines with the project, environment, database, output path, session expiry, and final `SYNCED` result
- A failed or timed-out TursoDB download removes temporary dump/database files and leaves an existing output untouched
- Is pull-only in the first version and does not push local changes back to the hosted environment
- SQLite-engine correctness continues to rely on Turso Sync; TursoDB snapshots are validated locally before publication
- Does not use the Database Shell session API, signed document-store URLs, backend snapshot artifacts, or long-running process executions
- Keeps restore through Turso Sync push out of scope; restore support must be designed as a separate workflow
- Does not print Turso tokens, SSM parameter values, direct database credentials, AWS credentials, or raw secrets

### `db shell`

Open an interactive Turso shell against the Active Environment Database for a hosted project environment.

```bash
pfcli db shell --project <project> --env <env>
pfcli db shell --project <project> --env <env> --ttl 30m
```

**Prerequisites:**
- Authenticate to Process Focus with `pfcli auth login`; Turso organisation membership is not required
- Install the external Turso CLI from https://docs.turso.tech/cli/installation and make `turso` available on `PATH`

**Options:**
- `--project` — Project number to open a shell for (internal project ID also accepted)
- `--env` — Environment name to open a shell for (internal environment ID also accepted)
- `--ttl` — Session lifetime; bare numbers are seconds, and duration units such as `900s`, `15m`, or `1h` are accepted. The default is 15 minutes. Values over 1 hour are rejected locally with `Database Shell TTL must be 1 hour or less.`

**Behavior and boundaries:**
- Calls the console GraphQL `createDatabaseShellSession` mutation using the Process Focus CLI login
- Requires the caller to have the Cedar `databaseShell` permission; otherwise the console returns permission denied
- Checks that `turso` is installed before requesting a Database Shell session, so unused database credentials are not minted when the external dependency is missing
- Launches `turso db shell` with inherited terminal input/output and returns the Turso process exit code
- Opens a live read-write shell for the Active Environment Database; changes affect the hosted environment immediately
- Targets only the Active Environment Database, not runtime colors, rollback candidate databases, retained backup databases, downloaded snapshots, or local SQLite files
- Is for live investigation and emergency repair, not database transfer, snapshot download, local SQLite, rollback, restore, or backup workflows; use the dedicated upload, download, rollback, restore, and backup workflows for those cases
- Receives a short-lived Turso database token scoped to one database; the token is not a group token and does not include database attach permissions
- Does not refresh expired sessions automatically; rerun `pfcli db shell` to create a new short-lived session
- Does not persist the Turso token in `pfcli` credentials, Turso config, temp files, or env files
- Prints target metadata and a read-write warning, but does not print the credential-bearing Turso URL
- Audits first-version Database Shell session creation only; individual SQL statements are not audited by Process Focus

### Runtime Logs

Inspect the currently deployed runtime logs through the console GraphQL API.

```bash
pfcli logs --project <id> --env <name>
pfcli canary-logs --project <id> --env <name>
```

**Commands:**
- `logs` — Show recent primary runtime logs
- `canary-logs` — Show recent canary runtime logs

**Options:**
- `--project` — Project number whose runtime logs to read (internal ID also accepted)
- `--env` — Environment name whose runtime logs to read

**V1 output contract:**
- Starts with a concise primary/canary status line
- The status line is `Showing recent primary logs.` or `Showing recent canary logs.`
- Prints each returned log event as timestamp plus raw log message only
- Prints a concise empty-state line when no events are returned
- Does not print deployment color, CloudWatch log group, AWS account ID, AWS region, or stream names
- Leaves raw JSON log messages unchanged; it does not parse, simplify, pretty-print, or redact them
- Shows recent runtime logs returned by the cloud API
- The command descriptions distinguish v1 from follow/streaming modes without promising a time window
- Because redaction is out of scope for v1, raw messages are printed exactly as returned

**Out of scope for v1:**
- Docker-step build-phase logs, Fargate logs, and CodeBuild logs
- `--follow`, `--since`, `--json`, filtering, redaction, and user-configurable output caps

### `stage`

Manage project stages through the console GraphQL API.

Requires valid CLI credentials in `~/.config/pf/credentials.json`.

#### `stage list`

List the stages for a project.

```bash
pfcli stage list --project <project-number>
```

**Options:**
- `--project` - Project number to query (internal project ID also accepted)

**Behavior:**
- Calls the console GraphQL `listProjectStages` query
- Prints one stage name per line
- Prints a clear empty-state message when the project has no stages

**Example:**
```bash
pfcli stage list --project 1234-5678-9012
```

#### `stage add`

Create a new stage in a project by starting the existing `/operations/add-stage` process.

```bash
pfcli stage add --project <project-number> <stage-name>
```

**Options:**
- `--project` - Project number to update (internal project ID also accepted)

**Arguments:**
- `stage-name` - Stage name to create

**Behavior:**
- Calls the generated `startOperationsAddStage` mutation
- Waits for execution completion and prints concise execution updates
- Prints `Stage created: <stage-name>` on success
- Prints a clean duplicate-stage error instead of raw database text

**Example:**
```bash
pfcli stage add --project 1234-5678-9012 Production
```

### `env`

Manage project environments through the console GraphQL API.

Requires valid CLI credentials in `~/.config/pf/credentials.json`.

#### `env list`

List the environments for a project, optionally narrowed to a single stage.

```bash
pfcli env list --project <project-number> [--stage <stage-name>]
```

**Options:**
- `--project` - Project number to query (internal project ID also accepted)
- `--stage` - Optional stage to filter by (internal stage ID also accepted)

**Behavior:**
- Calls the console GraphQL `listProjectEnvironments` query
- Prints `environment (stage)` when `--stage` is not supplied
- Prints one environment name per line when `--stage` is supplied
- Prints a clear empty-state message when the selected scope has no environments

**Example:**
```bash
pfcli env list --project 1234-5678-9012
pfcli env list --project 1234-5678-9012 --stage Production
```

#### `env add`

Create a new environment in a project stage by starting the existing `/operations/add-environment` process.

```bash
pfcli env add --project <project-number> --stage <stage-name> <env-name>
```

**Options:**
- `--project` - Project number to update (internal project ID also accepted)
- `--stage` - Stage name to target (internal stage ID also accepted)

**Arguments:**
- `env-name` - Environment name to create

**Behavior:**
- Calls the generated `startOperationsAddEnvironment` mutation
- Waits for execution completion and prints concise execution updates
- Prints `Environment created: <env-name>` on success
- Relies on the backend process for environment-name validation and stage/project resolution

**Example:**
```bash
pfcli env add --project 1234-5678-9012 --stage Production prd
```

### `custom-domain`

Show custom-domain certificate status and required DNS records through the console GraphQL API.

Requires valid CLI credentials in `~/.config/pf/credentials.json`.

```bash
pfcli custom-domain --project <project-number> --env <environment-name>
```

**Options:**
- `--project` — Project number to query (internal project ID also accepted)
- `--env` — Environment name to query (internal environment ID also accepted)

**Behavior:**
- Calls the console GraphQL `getDnsRecords` query
- The console backend resolves the customer AWS region and does the AWS lookups server-side
- Prints ACM validation CNAME records when present
- Prints the CloudFront site-access CNAME when available
- Prints the default domain when no custom domain is configured

**Example:**
```bash
pfcli custom-domain --project 0000-0000-0002 --env prod
```

### `config`

Manage stage-scoped project config values through the console GraphQL API.

Requires valid CLI credentials in `~/.config/pf/credentials.json`.

#### `config list`

List config parameters for a project stage.

```bash
pfcli config list --project <project-number> --stage <stage-name>
```

**Options:**
- `--project` — Project number to query (internal project ID also accepted)
- `--stage` — Stage name to query (internal stage ID also accepted)

**Example:**
```bash
pfcli config list --project 0000-0000-0002 --stage Development
```

#### `config get`

Get a single config parameter for a project stage.

```bash
pfcli config get --project <project-number> --stage <stage-name> --key <key>
```

**Options:**
- `--project` — Project number to query (internal project ID also accepted)
- `--stage` — Stage name to query (internal stage ID also accepted)
- `--key` — Config key to fetch

**Example:**
```bash
pfcli config get --project 0000-0000-0002 --stage Development --key API_URL
```

#### `config set`

Create or update a config parameter for a project stage.

```bash
pfcli config set --project <project-number> --stage <stage-name> <key>
pfcli config set --project <project-number> --stage <stage-name> <key>=<value>
pfcli config set --project <project-number> --stage <stage-name> <key> <value>
```

**Options:**
- `--project` — Project number to update (internal project ID also accepted)
- `--stage` — Stage name to update (internal stage ID also accepted)
- `--secret` — Store as a secret value

**Arguments:**
- One of `<key>` (copy the value from the exported environment variable), `<key>=<value>`, or `<key> <value>`
- The bare `<key>` form fails if the environment variable is unset; an environment variable set to an empty string remains valid

**Examples:**
```bash
export API_URL=https://example.com
pfcli config set --project 0000-0000-0002 --stage Development API_URL
pfcli config set --project 0000-0000-0002 --stage Development API_URL=https://example.com
pfcli config set --project 0000-0000-0002 --stage Development API_URL https://example.com
export API_TOKEN='...'
pfcli config set --project 0000-0000-0002 --stage Development API_TOKEN --secret
```

#### `config delete`

Delete a config parameter for a project stage.

```bash
pfcli config delete --project <project-number> --stage <stage-name> --key <key>
```

**Options:**
- `--project` — Project number to update (internal project ID also accepted)
- `--stage` — Stage name to update (internal stage ID also accepted)
- `--key` — Config key to delete

**Example:**
```bash
pfcli config delete --project 0000-0000-0002 --stage Development --key API_URL
```

#### `config copy-new`

Copy config parameters from another stage without overwriting keys that
already exist on the target stage. If `--from-stage` resolves to the same
stage as `--stage`, the command warns and does nothing.

```bash
pfcli config copy-new --project <project-number> --stage <target-stage-name> --from-stage <source-stage-name>
```

**Options:**
- `--project` — Project number to update (internal project ID also accepted)
- `--stage` — Target stage name to update (internal stage ID also accepted)
- `--from-stage` — Source stage name to copy from (internal stage ID also accepted)

**Example:**
```bash
pfcli config copy-new --project 0000-0000-0002 --stage Production --from-stage Development
```

### `import`

Import organisation to the configured database. Automatically runs system and custom
migrations before importing, so it works on a fresh database.

```bash
pfcli import <org-path>
```

**Arguments:**
- `org-path` — Path to the organisation directory

**Database path resolution:**
- Uses `SQLITE_DATABASE_PATH` when set
- Otherwise falls back to `<org-path>/db/pf.db`

**Example:**
```bash
SQLITE_DATABASE_PATH=./data.db pfcli import ./my-org
# or rely on default path ./my-org/db/pf.db
pfcli import ./my-org
```

### `migrate`

Run both system (`__drizzle_migrations_pf`) and org custom
(`__drizzle_migrations_org`) schema migrations. Useful as a standalone
command when you want to migrate without re-importing.

```bash
pfcli migrate <org-path>
```

**Arguments:**
- `org-path` — Path to the organisation directory

**Database path resolution:**
- Uses `SQLITE_DATABASE_PATH` when set
- Otherwise falls back to `<org-path>/db/pf.db`

**Example:**
```bash
SQLITE_DATABASE_PATH=./data.db pfcli migrate ./my-org
pfcli migrate ./my-org
```

### `migrate-custom`

Run custom schema migrations for organisation.

```bash
pfcli migrate-custom <org-path>
```

**Arguments:**
- `org-path` — Path to the organisation directory

**Database path resolution:**
- Uses `SQLITE_DATABASE_PATH` when set
- Otherwise falls back to `<org-path>/db/pf.db`

**Example:**
```bash
SQLITE_DATABASE_PATH=./data.db pfcli migrate-custom ./my-org
pfcli migrate-custom ./my-org
```

### `get-frontend-jwt`

Read the stored frontend JWT token from the database.

`import`, `refresh-frontend-jwt`, and `get-frontend-jwt` select the frontend
identity using the shared auth helpers: `FRONTEND_JWT_TOKEN`'s
`properties.clientId` takes precedence over `OAUTH_CLIENT_ID`, then `frontend`.
Minting and local development client registration likewise use the JWT's `aud`
before `OAUTH_AUDIENCE`, then `graphql-api`. The default still reads and preserves
the existing `frontend-jwt/frontend` database entry; other identities use their
own entries. Import preserves a matching stored token; refresh regenerates it.

Use the same identity/audience configuration for bootstrap import, the auth
server, and the frontend launcher. `OPENAUTH_CLIENTS` is a registry, not a
frontend selector: for a nondefault frontend, also set `OAUTH_CLIENT_ID` (and
`OAUTH_AUDIENCE` where needed), or provide `FRONTEND_JWT_TOKEN` to all these
processes. Its selected registry entry must use `client_jwt` authentication and
the matching audience. No client is inferred from an ambiguous array.
Development auto-registration runs only without `OPENAUTH_CLIENTS` and with
`NODE_ENV=development`. The packaged local runtime uses `NODE_ENV=production`
and requires explicit `OPENAUTH_CLIENTS` before starting its auth server; it
then refreshes/reads the selected stored JWT for the remaining services.

```bash
pfcli get-frontend-jwt <org-path>
```

**Arguments:**
- `org-path` — Path to the organisation directory (supports `PF_ORG` env var)

**Database path resolution:**
- Uses `SQLITE_DATABASE_PATH` when set
- Otherwise falls back to `<org-path>/db/pf.db`

**Example:**
```bash
pfcli get-frontend-jwt ./my-org
PF_ORG=./my-org pfcli get-frontend-jwt
```

### `auth login`

Login through the browser and store CLI credentials locally.

```bash
BASE_URL=http://localhost:3000 pfcli auth login
```

**Environment:**
- `BASE_URL` — Required. Frontend base URL used to start CLI auth flow

Credentials are saved to `~/.config/pf/credentials.json`.
The Dashboard hands credentials back through a state-protected localhost callback.
Delegated sessions require clicking **Allow CLI access** in the Dashboard before
export. Confirm only when you initiated CLI login and trust the local program.
A failed or expired handoff exits with status 1 without replacing existing credentials.
Missing, invalid, or nonpositive credential lifetimes are not accepted as success.
The stored deadline is capped by the JWT's absolute expiry and is not extended
while waiting for the browser launcher. Credentials that expire before callback
receipt or storage are rejected. JWT decoding here is only an expiry hint; the
API still verifies the credential and its current validity.

### `skills`

Print agent-oriented guidance served by the installed `pfcli` version.

```bash
pfcli skills list
pfcli skills get core
```

**Behavior:**
- `skills list` prints available skill names and descriptions
- `skills get <name>` prints the matching operational guide as Markdown
- Skill content is version-coupled to the executable, so agents should prefer it over stale cached examples

## Workflow

Typical development workflow:

```bash
# 0. (Optional) login from CLI first (stores ~/.config/pf/credentials.json)
BASE_URL=http://localhost:3000 pfcli auth login

# 1. Scaffold a new organisation
pfcli init ./my-org --email admin@example.com --identity-provider google

# 2. Edit source files (src/todo.ts, src/org.ts, etc.)

# 3. (Optional) Re-import after source changes for local development
pfcli import ./my-org

# 4. Build the organisation
pfcli build ./my-org

# 5. (Optional) Deploy built dist artifact
pfcli deploy ./my-org --project <project-number> --env <environment-name>

# 6. (Optional) fetch frontend JWT from DB
pfcli get-frontend-jwt ./my-org
```

## Environment Variables

| Variable | Description | Used By |
|----------|-------------|---------|
| `PF_ORG` | Default organisation directory path | `init`, `import`, `get-frontend-jwt` |
| `SQLITE_DATABASE_PATH` | Database path override (otherwise defaults to `<org-path>/db/pf.db`) | `import`, `migrate`, `migrate-custom`, `get-frontend-jwt` |
| `BASE_URL` | Frontend base URL for browser auth flow | `auth login` |
| `PFCLI_CREDENTIALS_PATH` | Override credentials file path (test/dev only) | `auth login`, `deploy`, `db shell` |
| `GRAPHQL_SERVER_URL` | Override GraphQL server URL for import-completed callback | `import` |
| `INTERNAL_API_SECRET` | Optional callback secret header for internal import notification | `import` |
| `OAUTH_ISSUER_URL` | Issuer URL used when creating frontend JWT during import | `import` |
| `OAUTH_AUDIENCE` | Audience for generated frontend JWT (default `graphql-api`) | `import` |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID (in org.ts) | org template/runtime |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret (in org.ts) | org template/runtime |
| `MY_EMAIL` | Admin email for initial invitation (in org.ts) | org template/runtime |

## Help

Show help for any command:

```bash
pfcli --help
pfcli init --help
pfcli build --help
```
