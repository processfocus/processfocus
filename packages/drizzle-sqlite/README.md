# About

Drizzle schema for SQLite.

# Usage

Set PF_ORG to migrate a specific organisation:

```sh
PF_ORG=examples/demo npx nx run drizzle-sqlite:migrate
```

You can also just specify a SQLITE_DATABASE_PATH:

```sh
npx nx run drizzle-sqlite:migrate
```

Migrate a remote Turso database (uses `@pf/layer-turso-cloud`, not drizzle-kit):

```sh
SQLITE_DATABASE_PATH=libsql://db-somewhere.aws-us-west-2.turso.io \
TURSO_AUTH_TOKEN=your-token-here \
bun cli/pfcli/src/main.ts migrate <org-path>
```

`drizzle-kit migrate` / `nx run drizzle-sqlite:migrate` is for local file
databases only. Remote Turso URLs are not supported on that path; use
`pfcli migrate` instead (ADR 0014).
