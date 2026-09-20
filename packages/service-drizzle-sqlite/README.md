# About

Provides SQLite database service layers for Effect applications using
Drizzle ORM. This package works with the Turso local, Turso Cloud, and sqlite-bun driver layers.

This package exports:

- **TypedSqliteDrizzle** / **TypedSqliteDrizzleLayer**: typed Drizzle access for the monorepo schema (requires a SqlClient from a driver layer)
- **DatabaseTest** (via `/test` export): Test database layer using in-memory SQLite with automatic migrations

# Usage

## Production Usage

```typescript
import { Effect } from "effect"
import { TursoLive } from "@pf/layer-turso-local"
import {
  TypedSqliteDrizzle,
  TypedSqliteDrizzleLayer,
} from "@pf/service-drizzle-sqlite"

const program = Effect.gen(function* () {
  const db = yield* TypedSqliteDrizzle
  return yield* db.query.process.findMany()
})

// Provide both the Drizzle layer and a SQLite driver layer
await Effect.runPromise(
  program.pipe(
    Effect.provide(TypedSqliteDrizzleLayer),
    Effect.provide(TursoLive)
  )
)
```

## Testing Usage

**Note**: Test utilities are exported via a separate path to avoid bundling test dependencies in production builds.

```typescript
import { describe, it } from "bun:test"
import { Effect } from "effect"
import { DatabaseTest } from "@pf/service-drizzle-sqlite/test"

describe("my database tests", () => {
  it("should store data correctly", async () => {
    const test = Effect.gen(function* () {
      // Test operations using an in-memory database
      // Migrations are automatically applied
      yield* myDatabaseOperation()
    })

    await Effect.runPromise(
      test.pipe(Effect.provide(DatabaseTest))
    )
  })
})
```

## Configuration

`TypedSqliteDrizzleLayer` requires a `SqlClient` from a driver layer:
- Use `@pf/layer-turso-local` for local Turso database files
- Use `@pf/layer-turso-cloud` for remote Turso Cloud databases
- Use `@pf/layer-sqlite-bun` for Bun runtime (local files only)

Configure the database path via the `SQLITE_DATABASE_PATH` environment variable in your driver layer.

## Note on Dependencies

The `@pf/db-info` dependency is required for TypeScript project references even though
it's not directly imported in the source code. This is because `@pf/layer-sqlite-bun`
(used by `DatabaseTest`) provides the `DatabaseConnectionInfo` type from `@pf/db-info`,
and TypeScript needs transitive project references for type declarations to be visible.
