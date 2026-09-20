# @pf/layer-turso-cloud

Effect SQL layer for remote Turso Cloud databases using native
`@tursodatabase/serverless` sessions.

This package is for remote database URLs only. Local file databases should use `@pf/layer-turso-local`.

## Exports

- `TursoCloudLive` - default layer reading `SQLITE_DATABASE_PATH` and `TURSO_AUTH_TOKEN`.
- `makeTursoCloudLive(options?)` - layer factory with configurable auth and transaction options.
- `TursoCloudBatch` - executes a collection of SQL statements atomically with
  an explicit foreign-key policy.
- `TursoCloudClientOptions` - options for auth-token injection, auth-token refresh, and deferred transactions.
- `withConcurrentTransaction(client, effect)` from `@pf/db-info` opts one
  transaction into concurrent mode when supported and enabled.

## Runtime Behavior

- Provides `SqlClient`, `TursoCloudBatch`, and `DatabaseConnectionInfo`.
- Adapts native `@tursodatabase/serverless` sessions to the SQL client expected
  by Effect and Drizzle.
- Shares one root Turso session for non-transactional statements. Each session
  uses a single Hrana baton, so concurrent statements and session closure are
  serialized through the same semaphore.
- Runs `PRAGMA foreign_keys = ON` lazily on the first query.
- Executes `TursoCloudBatch` statements through the serverless driver's atomic
  immediate batch, including server-side rollback on failure, without one HTTP
  request per statement. Logical restore callers can suspend foreign-key
  enforcement before that transaction and restore it afterward on the same
  session, using three requests regardless of statement count.
- Starts write transactions by default, matching the previous remote libsql runtime behavior.
- Opens a separate Turso session per transaction. There is no process-local
  transaction semaphore; transient lock contention is handled with bounded
  retries so the behavior is consistent across Lambda runtimes. Long-held write
  locks can still fail after the retry budget instead of queueing indefinitely.
- Supports `deferredTransactions` for callers that need deferred transaction starts.
- Can rebuild the underlying client and retry once when `refreshAuthToken` returns a changed token.
- Concurrent transactions are opt-in per operation. When
  `TURSO_CONCURRENT_TX=1`, `withConcurrentTransaction` from `@pf/db-info`
  starts the outer transaction with `BEGIN CONCURRENT`. With the flag missing
  or set to any other value, the same request safely falls back to
  `BEGIN IMMEDIATE`.

The layer preserves bounded retries for individual `BEGIN` and `COMMIT` lock
failures, but write-write commit conflicts are surfaced immediately and it
never retries a complete transaction body. A concurrent commit conflict
requires the caller to replay the whole operation, including re-reading and
recomputing state. Callers must opt in only when that semantic retry is safe and
separately implemented; transaction bodies with external side effects must not
be replayed blindly.
