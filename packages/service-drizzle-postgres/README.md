# service-drizzle-postgres

# About

Provides PostgreSQL database service layers for Effect applications using Drizzle ORM and `@effect/sql-pg`. This package exports two Layer configurations:

- **PostgresLive**: Production database layer configured via environment variables
- **PostgresTest**: Test database layer for running tests against an ephemeral PostgreSQL instance.

# Usage

## Production Usage

```typescript
import { Effect } from "effect"
import { DatabaseLive } from "@pf/service-drizzle-postgres"

const program = Effect.gen(function* () {
  // Your database operations here
})

// Provide the live database layer
// Configure via environment variables:
// - POSTGRES_HOST (default: localhost)
// - POSTGRES_PORT (default: 5432)
// - POSTGRES_DATABASE (default: postgres)
// - POSTGRES_USERNAME (default: postgres)
// - POSTGRES_PASSWORD (required)
await Effect.runPromise(
  program.pipe(Effect.provide(DatabaseLive))
)
```

## Testing Usage

We use vitest for testing. The reason is that the `testcontainers`
package to start a postgres docker container does not seem to work
with bun.

```typescript
import { SqlClient } from "@effect/sql"
import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as schema from "@pf/drizzle-postgres"
import { PostgresTest } from "./postgres-test"
import { TypedPostgresDrizzle } from "../src/lib/typed-drizzle"

it.layer(PostgresTest, { timeout: "60 seconds" })("PgClient", (it) => {
  it.effect("Test migration", () =>
    Effect.gen(function* () {
      const db = yield* TypedPostgresDrizzle

      const orgUnits = yield* db.select().from(schema.orgUnit)
      expect(orgUnits.length).toBe(0)
    })
  )
})
```
