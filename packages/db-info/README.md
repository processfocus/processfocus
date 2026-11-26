# @pf/db-info

Shared database infrastructure used by driver layers and their callers:
connection descriptions, path configuration, transaction controls, and optional
read batching.

Keeping these contracts independent of a particular driver lets the SQLite,
Turso, and PostgreSQL packages share them without depending on one another.

## Immediate transactions

Turso adapters support reserving the writer before validation reads. Choose
transaction mode at the outer boundary: a nested transaction cannot change the
mode of its enclosing transaction.

Transaction helpers do not replay the operation. Any retry of a complete
transaction belongs to the caller, which knows whether its work is safe to repeat.

See the [exports](./src/index.ts) for the available contracts and the
[Turso Cloud layer](../layer-turso-cloud/README.md) for remote-driver behavior.
