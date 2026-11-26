# @pf/request-time

Provides one timestamp shared by all operations within a request.

Using a consistent request time keeps database writes, authorization checks,
replication, and audit records aligned even when a request performs many
operations.
