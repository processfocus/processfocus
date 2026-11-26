# pfcli

`pfcli` builds Process Focus organisations and manages their cloud hosting.
Use [pforg](../pforg/README.md) to work with Processes, Todos and records inside
an organisation.

## Local development

```bash
pfcli init ./my-org --email admin@example.com --identity-provider google
```

This creates an organisation, installs its dependencies and imports it into a
local database. Configure the selected identity provider before signing in.

Edit the organisation's source, then import again to update the local database,
or build to produce deployment artifacts:

```bash
pfcli import ./my-org
pfcli build ./my-org
```

Import includes schema migrations. Use `--database-path` when the database is
outside the organisation's default `db/pf.db` location.

## Cloud hosting

Hosted builds require `platformRef` on the authored `Organisation`. To verify
merged public-package changes, use an authorized existing Backend and set
`platformRef: "trunk"`. For a reproducible deployment, select a full commit SHA.
The CLI builds with `PF_ENV` set to the target customer environment, so the org
can select a different ref per environment, for example
`platformRef: process.env["PF_ENV"] === "prd" ? releaseCommit : "trunk"`.

Set `platformSource: "public"` to resolve `platformRef` in the official
`processfocus/processfocus` mirror. Use a branch name such as `"trunk"` to
follow that branch. Each Deploy Attempt resolves the branch once and uses the
same commit for the Dashboard and generic runtime. Starting a new Deploy
Attempt resolves the branch again and can pick up a newer commit. The build logs
`Deployment platform SHA` alongside `Deployment Backend SHA`, which identifies
the revision supplying the AWS deployment code. To reproduce the public inputs
after the branch advances, keep `platformSource: "public"` and set `platformRef`
to the logged platform SHA.

Omitting `platformSource` resolves `platformRef` in the private monorepo
(`processfocus/monorepo`). If the selected ref cannot be checked out, the
deployment stops without falling back to another source or to published packages.

Log in to the Console, choose a project and environment, then deploy:

```bash
pfcli auth login --base-url <console-origin>
pfcli projects
pfcli env list --project <project-number>
pfcli deploy ./my-org --project <project-number> --env <environment-name>
pfcli deploy status --project <project-number> --env <environment-name>
```

Deploy checks for an active Backend execution before building or uploading,
even with `--no-wait`. Ctrl-C stops waiting, not deployment. After an
interruption or timeout, run `pfcli deploy status` for the same project and
environment before retrying. Status reflects the Backend process execution,
not the underlying CodeBuild runner.

Configuration belongs to a project's stage. For example, to store an already
exported environment variable as a secret:

```bash
pfcli config set --project <project-number> --stage <stage-name> API_TOKEN --secret
```

Redeploy after changing stage configuration. Use `logs` for runtime diagnostics
and `custom-domain` for certificate status and DNS records.

For GitHub Actions authentication, see
[project OIDC federation](../../docs/authentication/project-workloads.md).
Manage federated identities with `pfcli workload`; the command name and
`PFCLI_AUTH_MODE=github-workload` configuration remain unchanged.

Use `pfcli workload save --environment <name>` when the GitHub Actions job
uses a GitHub Environment. Omit `--environment` to match jobs without one;
omitting it on an edit removes the previous setting. Adding, changing, or
removing the setting requires enrollment again. This does not change the
Process Focus deployment target selected by `pfcli deploy --env`.

In GitHub workload mode, `deploy`, `db download`, `db upload`, `env add`, and
`destroy` request their corresponding machine permission. Grant each operation
on the enrolled project's workload. `PFCLI_WORKLOAD_PROVIDER_USER` is retired
and explicitly rejected.
Long-running commands exchange fresh GitHub assertions as needed. Failed
OIDC authentication never falls back to saved credentials or a client secret.

## Databases and access

- `db download` creates a local copy; local edits do not update the hosted database.
- `db upload` replaces hosted data. Its default `data-copy` mode preserves the
  destination's authentication identity; `exact-restore` also replaces authentication
  state.
- `db shell` opens live read-write access using the external
  [Turso CLI](https://docs.turso.tech/cli/installation). It requires Database Shell
  permission. Its short-lived token may be visible in local process listings.
- `invitation` and `grant role` support operator bootstrap and access management.
  Registration Links, recovery links and frontend JWTs are credentials; keep
  their output private.
- `destroy` deletes a hosted environment and its AWS stacks and requires `--yes`.

## Command help

```bash
pfcli --help
pfcli deploy --help
pfcli deploy status --help
pfcli --completions bash
```

The package also includes a generated [command reference](dist/command-reference.md)
and [Usage spec](dist/pfcli.usage.kdl). These are created during the build and
shipped with the release.
