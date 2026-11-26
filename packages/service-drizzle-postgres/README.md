# @pf/service-drizzle-postgres

Typed Drizzle database access for the generated
[`@pf/drizzle-postgres`](../drizzle-postgres/README.md) schema, integrated with
Effect's PostgreSQL client.

Runtime composition supplies the configured SQL client and typed Drizzle layer.
Application operations live in
[`@pf/postgres-operations`](../postgres-operations/README.md).

See the [connection layer](./src/lib/postgres-live.ts) for configuration.
