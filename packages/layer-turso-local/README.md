# @pf/layer-turso-local

Effect SQL layer for the Turso local database SDK.

The Turso features we rely on for local databases are enabled by default:

- multi-process access via `experimental: ["multiprocess_wal"]`
- regular WAL transactions for compatibility with Turso's multi-process coordinator

Every transaction opened through `SqlClient.withTransaction` uses a regular `BEGIN`.
Turso's multi-process WAL mode is not compatible with MVCC / `BEGIN CONCURRENT`.

`executeValues` uses Turso statement raw mode so Drizzle receives positional rows, including queries with duplicate result column names.
