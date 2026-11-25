# @pf/layer-turso-local

An Effect SQL driver for local Turso database files, with multi-process WAL
support so runtime processes can share a database.

Use [`@pf/service-drizzle-sqlite`](../service-drizzle-sqlite/README.md) for typed
Process Focus queries, or
[`@pf/layer-turso-cloud`](../layer-turso-cloud/README.md) for remote databases.

Local transactions use WAL rather than MVCC/concurrent mode. Shared transaction
controls are described in [`@pf/db-info`](../db-info/README.md).
