import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { ConfigProvider, Effect, Layer } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import {
  isSqlLockError,
  withImmediateTransaction,
  withReadSnapshot,
} from "@pf/db-info"
import { makeTursoLive } from "../src/index"
import { describe, expect, it } from "bun:test"

const tempDbPath = async () =>
  join(await mkdtemp(join(tmpdir(), "test-turso-")), "test.db")

const sqlQuery = (sql: string) => Object.assign([sql], { raw: [sql] })

const cleanupDb = async (dbPath: string) => {
  await rm(dirname(dbPath), { recursive: true })
}

describe("makeTursoLive", () => {
  it("removes the database and all sidecars after a failed database operation", async () => {
    const dbPath = await tempDbPath()
    const layer = makeTursoLive().pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ SQLITE_DATABASE_PATH: dbPath }),
        ),
      ),
    )
    const run = async () => {
      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            yield* sql.unsafe("CREATE TABLE cleanup_value (value TEXT)")
            yield* Effect.fail(new Error("operation failed"))
          }).pipe(Effect.provide(layer)),
        )
      } finally {
        await cleanupDb(dbPath)
      }
    }
    await expect(run()).rejects.toThrow("operation failed")
    expect(existsSync(dirname(dbPath))).toBe(false)
  })

  it("excludes a competing process before reads, then progresses and rolls back without replay", async () => {
    const dbPath = await tempDbPath()
    const layer = makeTursoLive({ busy_timeout: 25 }).pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            SQLITE_DATABASE_PATH: dbPath,
            TURSO_CONCURRENT_TX: "1",
          }),
        ),
      ),
    )
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql.unsafe(
            "CREATE TABLE immediate_values (value TEXT NOT NULL)",
          )
          const writer = Bun.spawn(
            [
              process.execPath,
              `${import.meta.dir}/fixtures/holding-writer.ts`,
              dbPath,
            ],
            {
              stdin: "pipe",
              stdout: "pipe",
              stderr: "pipe",
            },
          )
          yield* Effect.gen(function* () {
            const reader = writer.stdout.getReader()
            const ready = yield* Effect.promise(() => reader.read())
            expect(new TextDecoder().decode(ready.value)).toBe("ready\n")
            reader.releaseLock()
            let bodyRuns = 0
            const body = Effect.gen(function* () {
              bodyRuns += 1
              const rows = yield* sql.unsafe(
                "SELECT value FROM immediate_values",
              )
              yield* sql.unsafe(
                "INSERT INTO immediate_values VALUES ('callback')",
              )
              return rows
            })
            const started = Date.now()
            const error = yield* Effect.flip(
              withImmediateTransaction(sql, body),
            )
            expect(isSqlLockError(error)).toBe(true)
            expect(bodyRuns).toBe(0)
            expect(Date.now() - started).toBeLessThan(2000)
            writer.stdin.write("commit\n")
            writer.stdin.end()
            expect(yield* Effect.promise(() => writer.exited)).toBe(0)
            expect(yield* withImmediateTransaction(sql, body)).toEqual([
              { value: "competitor" },
            ])
            expect(bodyRuns).toBe(1)
            const failure = yield* Effect.flip(
              withImmediateTransaction(
                sql,
                Effect.gen(function* () {
                  yield* sql.unsafe(
                    "INSERT INTO immediate_values VALUES ('rolled back')",
                  )
                  return yield* Effect.fail("callback failure")
                }),
              ),
            )
            expect(failure).toBe("callback failure")
            expect(
              yield* sql.unsafe(
                "SELECT value FROM immediate_values ORDER BY value",
              ),
            ).toEqual([{ value: "callback" }, { value: "competitor" }])
          }).pipe(
            Effect.ensuring(
              Effect.promise(async () => {
                writer.kill()
                await writer.exited
              }),
            ),
          )
        }).pipe(Effect.provide(layer)),
      )
    } finally {
      await cleanupDb(dbPath)
    }
  }, 10000)

  it("keeps a read snapshot stable while another connection commits", async () => {
    const dbPath = await tempDbPath()
    const config = ConfigProvider.layer(
      ConfigProvider.fromUnknown(
        Object.fromEntries(new Map([["SQLITE_DATABASE_PATH", dbPath]])),
      ),
    )
    const reader = makeTursoLive().pipe(Layer.provide(config))
    const writer = makeTursoLive().pipe(Layer.provide(config))
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql.unsafe(
            "CREATE TABLE snapshot_value (value INTEGER NOT NULL)",
          )
          yield* sql.unsafe("INSERT INTO snapshot_value VALUES (1)")
          yield* withReadSnapshot(
            sql,
            Effect.gen(function* () {
              expect(
                yield* sql.unsafe("SELECT value FROM snapshot_value"),
              ).toEqual([{ value: 1 }])
              // A separate runtime keeps the writer outside the reader's transaction context.
              yield* Effect.promise(() =>
                Effect.runPromise(
                  Effect.gen(function* () {
                    const sql = yield* SqlClient.SqlClient
                    yield* sql.unsafe("UPDATE snapshot_value SET value = 2")
                  }).pipe(Effect.provide(writer)),
                ),
              )
              expect(
                yield* sql.unsafe("SELECT value FROM snapshot_value"),
              ).toEqual([{ value: 1 }])
            }),
          )
          expect(yield* sql.unsafe("SELECT value FROM snapshot_value")).toEqual(
            [{ value: 2 }],
          )
        }).pipe(Effect.provide(reader)),
      )
    } finally {
      await cleanupDb(dbPath)
    }
  })

  it("uses WAL-backed transactions", async () => {
    const dbPath = await tempDbPath()
    const ConfigLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown(
        Object.fromEntries(new Map([["SQLITE_DATABASE_PATH", dbPath]])),
      ),
    )
    const TestLayer = makeTursoLive().pipe(Layer.provide(ConfigLayer))

    try {
      const rows = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient

          yield* sql(sqlQuery("CREATE TABLE test_values (value TEXT NOT NULL)"))
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql(
                sqlQuery("INSERT INTO test_values (value) VALUES ('ok')"),
              )
            }),
          )

          return yield* sql(sqlQuery("SELECT value FROM test_values"))
        }).pipe(Effect.provide(TestLayer)),
      )

      expect(rows).toEqual([{ value: "ok" }])
    } finally {
      await cleanupDb(dbPath)
    }
  })

  it("makes writes visible across long-lived clients", async () => {
    const dbPath = await tempDbPath()
    const ConfigLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown(
        Object.fromEntries(new Map([["SQLITE_DATABASE_PATH", dbPath]])),
      ),
    )
    const WriterLayer = makeTursoLive().pipe(Layer.provide(ConfigLayer))
    const ReaderLayer = makeTursoLive().pipe(Layer.provide(ConfigLayer))

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient

          yield* sql(sqlQuery("CREATE TABLE visible (value TEXT NOT NULL)"))
        }).pipe(Effect.provide(WriterLayer)),
      )

      const readVisible = () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient

            return yield* sql(sqlQuery("SELECT value FROM visible"))
          }).pipe(Effect.provide(ReaderLayer)),
        )

      expect(await readVisible()).toEqual([])

      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient

          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql(sqlQuery("INSERT INTO visible (value) VALUES ('ok')"))
            }),
          )
        }).pipe(Effect.provide(WriterLayer)),
      )

      expect(await readVisible()).toEqual([{ value: "ok" }])
    } finally {
      await cleanupDb(dbPath)
    }
  })

  it("supports partial unique-index upserts", async () => {
    const dbPath = await tempDbPath()
    const ConfigLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown(
        Object.fromEntries(new Map([["SQLITE_DATABASE_PATH", dbPath]])),
      ),
    )
    const TestLayer = makeTursoLive().pipe(Layer.provide(ConfigLayer))

    try {
      const rows = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient

          yield* sql(
            sqlQuery(
              "CREATE TABLE items (path TEXT NOT NULL, _deleted INTEGER NOT NULL DEFAULT 0, value TEXT NOT NULL)",
            ),
          )
          yield* sql(
            sqlQuery(
              "CREATE UNIQUE INDEX items_path_active ON items(path) WHERE _deleted = 0",
            ),
          )
          yield* sql.unsafe(
            "INSERT INTO items (path, _deleted, value) VALUES (?, 0, ?) ON CONFLICT (path) WHERE _deleted = 0 DO UPDATE SET value = excluded.value",
            ["/a", "one"],
          )
          yield* sql.unsafe(
            "INSERT INTO items (path, _deleted, value) VALUES (?, 0, ?) ON CONFLICT (path) WHERE _deleted = 0 DO UPDATE SET value = excluded.value",
            ["/a", "two"],
          )

          return yield* sql(sqlQuery("SELECT path, _deleted, value FROM items"))
        }).pipe(Effect.provide(TestLayer)),
      )

      expect(rows).toEqual([{ path: "/a", _deleted: 0, value: "two" }])
    } finally {
      await cleanupDb(dbPath)
    }
  })

  it("preserves duplicate selected columns in values mode", async () => {
    const dbPath = await tempDbPath()
    const ConfigLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown(
        Object.fromEntries(new Map([["SQLITE_DATABASE_PATH", dbPath]])),
      ),
    )
    const TestLayer = makeTursoLive().pipe(Layer.provide(ConfigLayer))

    try {
      const rows = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient

          yield* sql(
            sqlQuery(
              "CREATE TABLE a (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
            ),
          )
          yield* sql(
            sqlQuery(
              "CREATE TABLE b (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
            ),
          )
          yield* sql.unsafe("INSERT INTO a (id, value) VALUES (?, ?)", [1, "a"])
          yield* sql.unsafe("INSERT INTO b (id, value) VALUES (?, ?)", [1, "b"])

          return yield* sql.unsafe(
            "SELECT a.id, b.id, a.value, b.value FROM a JOIN b ON a.id = b.id",
            [],
          ).values
        }).pipe(Effect.provide(TestLayer)),
      )

      expect(rows).toEqual([[1, 1, "a", "b"]])
    } finally {
      await cleanupDb(dbPath)
    }
  })
})
