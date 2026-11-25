# @pf/drizzle-sqlite

Generated SQLite Drizzle schema and migrations for the shared
[database model](../db-schema/README.md).

[`@pf/service-drizzle-sqlite`](../service-drizzle-sqlite/README.md) supplies typed
database access over a local or remote driver.

## Migrations

The Drizzle migration path is for local file databases. Remote Turso databases
use `pfcli migrate`, which runs through the Turso Cloud driver.
