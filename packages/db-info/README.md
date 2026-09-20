# @pf/db-info

Shared database connection information service used across all database driver layers.

## Purpose

This package provides a single `DatabaseConnectionInfo` Effect service that database driver layers can implement to expose their connection details for logging and debugging purposes. This avoids circular dependencies between driver layers and higher-level packages.

## Usage

Database driver layers (like `@pf/layer-sqlite-bun`, `@pf/layer-turso-local`, `@pf/layer-turso-cloud`, and `@pf/service-drizzle-postgres`) provide this service with their connection information. Applications can then access it for logging:

```typescript
import { DatabaseConnectionInfo } from "@pf/db-info"
import { Effect } from "effect"

const program = Effect.gen(function* () {
  const connectionInfo = yield* DatabaseConnectionInfo
  yield* Effect.log(`Connected to: ${connectionInfo}`)
})
```

## Connection Info Examples

- SQLite in-memory: `:memory:`
- SQLite local file (sqlite-bun): `./data/pf.db`
- Turso local file: `file://./data/pf.db`
- Remote Turso: `libsql://my-db.turso.io`
- PostgreSQL: `postgresql://user@localhost:5432/dbname`

## Implementation

Database driver layers provide this service by creating a layer that yields the connection string:

```typescript
import { DatabaseConnectionInfo } from "@pf/db-info"
import { Layer } from "effect"

const ConnectionInfoLayer = Layer.succeed(DatabaseConnectionInfo, ":memory:")
```

The service is then merged with other driver layers and passed through to consumers via `Layer.passthrough()` in typed Drizzle layers.
