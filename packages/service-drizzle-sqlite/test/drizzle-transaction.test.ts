import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { SqlClient } from "effect/sql"
import { SqliteTest } from "@pf/layer-sqlite-bun"
import {
  batchSqliteReads,
  makeSqliteDrizzle,
} from "../src/lib/make-sqlite-drizzle"
import { expect, it } from "bun:test"

const items = sqliteTable("adapter_items", {
  id: integer().primaryKey(),
  value: text().notNull(),
})

it("keeps yielded Drizzle queries on the SQL transaction through savepoints, failure and interruption", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const db = yield* makeSqliteDrizzle({ schema: { items } })
      yield* sql`CREATE TABLE adapter_items (id INTEGER PRIMARY KEY, value TEXT NOT NULL)`
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* db.insert(items).values({ id: 1, value: "committed" })
          const nested = yield* Effect.exit(
            sql.withTransaction(
              Effect.gen(function* () {
                yield* db
                  .insert(items)
                  .values({ id: 2, value: "savepoint rollback" })
                return yield* Effect.fail("rollback")
              }),
            ),
          )
          expect(Exit.isFailure(nested)).toBe(true)
          expect(
            yield* batchSqliteReads(db, [
              db.select().from(items),
              db.select({ value: items.value }).from(items),
            ]),
          ).toEqual([[{ id: 1, value: "committed" }], [{ value: "committed" }]])
        }),
      )
      const written = yield* Deferred.make<void>()
      const transaction = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* db.insert(items).values({ id: 3, value: "interrupted" })
            yield* Deferred.succeed(written, undefined)
            yield* Effect.never
          }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(written)
      yield* Fiber.interrupt(transaction)
      expect(yield* db.select().from(items)).toEqual([
        { id: 1, value: "committed" },
      ])
      // Reusing the connection after cancellation also proves rollback released it.
      yield* db.insert(items).values({ id: 4, value: "reused" })
      expect(yield* db.select({ value: items.value }).from(items)).toEqual([
        { value: "committed" },
        { value: "reused" },
      ])
    }).pipe(Effect.provide(SqliteTest)),
  )
})
