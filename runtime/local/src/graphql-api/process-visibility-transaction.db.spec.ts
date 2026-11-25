import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigProvider, Effect, Layer, ManagedRuntime, Result } from "effect"
import { SqlClient } from "effect/sql"
import { causeChainIncludes } from "@pf/db-info"
import { makeTursoLive } from "@pf/layer-turso-local"
import { withProcessVisibilityTransaction } from "../../../../packages/graphql-api/src/lib/rxdb/process-visibility-transaction"
import { expect, it } from "bun:test"

it.each(["one conflict", "persistent conflicts", "constraint failure"])(
  "recovers visibility transactions only within their retry budget: %s",
  async (scenario) => {
    const directory = await mkdtemp(join(tmpdir(), "visibility-retry-"))
    const config = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        SQLITE_DATABASE_PATH: join(directory, "db"),
      }),
    )
    const reader = ManagedRuntime.make(
      makeTursoLive().pipe(Layer.provide(config)),
    )
    const writer = ManagedRuntime.make(
      makeTursoLive().pipe(Layer.provide(config)),
    )
    try {
      await reader.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`CREATE TABLE source (version INTEGER NOT NULL)`
          yield* sql`INSERT INTO source VALUES (1)`
          yield* sql`CREATE TABLE observed (version INTEGER NOT NULL)`
        }),
      )
      let attempts = 0
      const seen: number[] = []
      const result = await reader.runPromise(
        withProcessVisibilityTransaction(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            const [row] = yield* sql<{
              version: number
            }>`SELECT version FROM source`
            if (!row) throw new Error("Missing source row")
            seen.push(row.version)
            attempts++
            if (scenario === "constraint failure") {
              yield* sql`INSERT INTO observed VALUES (NULL)`
            } else if (attempts === 1 || scenario === "persistent conflicts") {
              // A separate runtime commits outside the reader's transaction context.
              yield* Effect.promise(() =>
                writer.runPromise(
                  Effect.flatMap(
                    SqlClient.SqlClient,
                    (sql) => sql`UPDATE source SET version = version + 1`,
                  ),
                ),
              )
            }
            yield* sql`INSERT INTO observed VALUES (${row.version})`
          }),
        ).pipe(Effect.result),
      )
      if (scenario === "one conflict") {
        expect(Result.isSuccess(result)).toBe(true)
        expect(seen).toEqual([1, 2])
      } else {
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(
            causeChainIncludes(result.failure, (message) =>
              message
                .toLowerCase()
                .includes(
                  scenario === "persistent conflicts"
                    ? "snapshot is stale"
                    : "not null",
                ),
            ),
          ).toBe(true)
        }
        expect(attempts).toBe(scenario === "persistent conflicts" ? 5 : 1)
      }
      expect(
        await reader.runPromise(
          Effect.flatMap(
            SqlClient.SqlClient,
            (sql) => sql`SELECT version FROM observed`,
          ),
        ),
      ).toEqual(scenario === "one conflict" ? [{ version: 2 }] : [])
    } finally {
      await reader.dispose()
      await writer.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  },
)
