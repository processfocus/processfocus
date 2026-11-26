# @pf/service-drizzle-sqlite

Typed Drizzle access to the Process Focus SQLite schema from Effect code.
Queries participate in the caller's transaction and cancellation context.

Choose a driver for the database location:

- [`@pf/layer-turso-local`](../layer-turso-local/README.md): local Turso files.
- [`@pf/layer-turso-cloud`](../layer-turso-cloud/README.md): remote Turso Cloud.
- [`@pf/layer-sqlite-bun`](../layer-sqlite-bun/README.md): Bun SQLite files or
  in-memory databases.

Application database operations live in
[`@pf/sqlite-operations`](../sqlite-operations/README.md). Test database support
is available through this package's separate `/test` entry point.
