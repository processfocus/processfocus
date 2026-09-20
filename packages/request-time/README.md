# @pf/request-time

Service providing a FiberRef with a single timestamp for all operations within a request.

This ensures all database operations and resolvers use the same timestamp, providing consistency for RxDB replication and audit trails.

The timestamp is updated at the start of each GraphQL request and inherited by all resolver effects running in child fibers.
