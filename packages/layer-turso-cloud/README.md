# @pf/layer-turso-cloud

An Effect SQL driver for remote Turso Cloud databases, using
`@tursodatabase/serverless`. Local files use
[`@pf/layer-turso-local`](../layer-turso-local/README.md).

The layer manages remote sessions, authentication, and transactions. It also
supports atomic write batches and explicit groups of independent reads, reducing
network round trips.

## Transactions

Transactions share a dedicated session and queue within each process.
Non-transactional reads use a separate session. Keep transaction work short and
avoid waiting for another top-level transaction on the same client.

Transaction mode is chosen at the outer boundary. The driver retries bounded
lock acquisition failures, but never replays a transaction body.

See [shared database controls](../db-info/README.md) and the
[driver options](./src/lib/client-live.ts) for configuration.
