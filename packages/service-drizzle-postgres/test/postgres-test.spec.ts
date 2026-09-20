// biome-ignore-all lint/style/noNonNullAssertion: test assertions
import { SqlClient } from "@effect/sql"
import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as schema from "@pf/drizzle-postgres"
import { TypedPostgresDrizzle } from "../src/lib/typed-drizzle"
import { PostgresTest } from "./postgres-test"

it.layer(PostgresTest, { timeout: "60 seconds" })("PgClient", (it) => {
  it.effect("Test migration", () =>
    Effect.gen(function* () {
      const db = yield* TypedPostgresDrizzle

      const orgUnits = yield* db.select().from(schema.orgUnit)
      expect(orgUnits.length).toBe(0)
    }),
  )

  it.effect("Test transaction", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const db = yield* TypedPostgresDrizzle

      // Test basic transaction - should see inserted data inside transaction
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const insertResult = yield* db
            .insert(schema.orgUnit)
            .values({
              name: "Test Org Unit",
              orgUnitLevel: "department",
              path: "test-org-unit",
            })
            .returning({ id: schema.orgUnit.id })

          const orgUnits = yield* db.select().from(schema.orgUnit)
          expect(orgUnits.length).toBe(1)
          expect(insertResult.length).toBe(1)
          expect(insertResult[0]?.id).toBeDefined()
        }),
      )

      // Verify data persisted after successful transaction
      const orgUnitsAfter = yield* db.select().from(schema.orgUnit)
      expect(orgUnitsAfter.length).toBe(1)
    }),
  )

  it.effect("Test transaction rollback", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const db = yield* TypedPostgresDrizzle

      // Check initial count (previous test inserted 1)
      const orgUnitsBefore = yield* db.select().from(schema.orgUnit)
      const initialCount = orgUnitsBefore.length

      // Insert data in a transaction that fails - should rollback
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* db.insert(schema.orgUnit).values({
              name: "Rollback Org Unit",
              orgUnitLevel: "team",
              path: "rollback-org-unit",
            })

            const orgUnits = yield* db.select().from(schema.orgUnit)
            expect(orgUnits.length).toBe(initialCount + 1)

            // Force rollback
            return yield* Effect.fail("rollback")
          }),
        )
        .pipe(Effect.ignore)

      // Verify data was rolled back - count should be unchanged
      const orgUnitsAfter = yield* db.select().from(schema.orgUnit)
      expect(orgUnitsAfter.length).toBe(initialCount)
    }),
  )
})
