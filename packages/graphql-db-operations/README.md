# @pf/graphql-db-operations

Database service contracts used by the GraphQL API and process runtime, with
shared helpers for composing those operations.

These contracts keep application code independent of the database driver.
Concrete implementations live in
[`@pf/sqlite-operations`](../sqlite-operations/README.md) and
[`@pf/postgres-operations`](../postgres-operations/README.md).
