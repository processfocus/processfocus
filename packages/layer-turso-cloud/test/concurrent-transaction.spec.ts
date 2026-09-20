import * as SqlClient from "@effect/sql/SqlClient"
import { SqlError } from "@effect/sql/SqlError"
import {
  ConfigProvider,
  Effect,
  Exit,
  Fiber,
  Layer,
  Redacted,
  Schedule,
  TestClock,
  TestContext,
} from "effect"
import {
  getTransactionMode,
  isSqlLockError,
  isSqlWriteWriteConflictError,
  withConcurrentTransaction,
} from "@pf/db-info"
import { beforeEach, describe, expect, it, mock } from "bun:test"

const sequences: string[] = []
const executions: string[] = []
const requests: string[] = []
const batches: Array<{
  readonly statements: ReadonlyArray<string>
  readonly mode: string | undefined
}> = []
let batchFailureMessage: string | undefined
let batchFailuresRemaining: number | undefined
let foreignKeysOnFailures = 0
let foreignKeysOnFailureMessage = "failed to restore foreign keys"
let refreshAuthTokenCalls = 0
let beginBusyFailures = 0
let commitBusyFailures = 0
let commitConflictFailures = 0
let closeCalls = 0
let transactionCloseCalls = 0
let executeFailure: Error | undefined

const emptyResult = {
  columns: [],
  columnTypes: [],
  rows: [],
  rowsAffected: 0,
}

mock.module("@tursodatabase/serverless", () => ({
  Session: class {
    private isTransaction = false

    execute(sql: string, _params: ReadonlyArray<unknown>) {
      executions.push(sql)
      requests.push(`execute:${sql}`)
      if (sql === "PRAGMA foreign_keys = ON" && foreignKeysOnFailures > 0) {
        foreignKeysOnFailures -= 1
        return Promise.reject(new Error(foreignKeysOnFailureMessage))
      }
      if (sql !== "PRAGMA foreign_keys = ON" && executeFailure) {
        return Promise.reject(executeFailure)
      }
      return Promise.resolve(emptyResult)
    }

    batch(statements: ReadonlyArray<string>, mode?: string) {
      batches.push({ statements, mode })
      requests.push("batch")
      if (batchFailureMessage !== undefined && batchFailuresRemaining !== 0) {
        if (batchFailuresRemaining !== undefined) {
          batchFailuresRemaining -= 1
        }
        return Promise.reject(new Error(batchFailureMessage))
      }
      return Promise.resolve(statements.map(() => emptyResult))
    }

    sequence(sql: string) {
      sequences.push(sql)
      if (sql.startsWith("BEGIN ")) {
        this.isTransaction = true
      }

      if (sql.startsWith("BEGIN ") && beginBusyFailures > 0) {
        beginBusyFailures -= 1
        return Promise.reject(new Error("SQLITE_BUSY: database is locked"))
      }

      if (sql === "COMMIT" && commitBusyFailures > 0) {
        commitBusyFailures -= 1
        return Promise.reject(new Error("SQLITE_BUSY: database is locked"))
      }

      if (sql === "COMMIT" && commitConflictFailures > 0) {
        commitConflictFailures -= 1
        return Promise.reject(new Error("Tursodb error: Write-write conflict"))
      }

      return Promise.resolve(emptyResult)
    }

    close() {
      closeCalls += 1
      if (this.isTransaction) {
        transactionCloseCalls += 1
      }
      return Promise.resolve()
    }
  },
}))

const { makeTursoCloudLive, TursoCloudBatch } = await import("../src/index")

const makeTestLayer = (
  concurrentFlag: string | undefined,
  options?: Parameters<typeof makeTursoCloudLive>[0],
) => {
  const values = new Map([["SQLITE_DATABASE_PATH", "libsql://test.turso.io"]])
  if (concurrentFlag !== undefined) {
    values.set("TURSO_CONCURRENT_TX", concurrentFlag)
  }

  const configLayer = Layer.setConfigProvider(ConfigProvider.fromMap(values))
  return makeTursoCloudLive(options).pipe(Layer.provide(configLayer))
}

const runOnTestClock = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  layer: Layer.Layer<R>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(effect)
      yield* TestClock.adjust("10 seconds")
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(layer), Effect.provide(TestContext.TestContext)),
  )

const runTransaction = (
  concurrentFlag: string | undefined,
  options?: Parameters<typeof makeTursoCloudLive>[0],
) =>
  runOnTestClock(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return yield* withConcurrentTransaction(sql, Effect.succeed("committed"))
    }),
    makeTestLayer(concurrentFlag, options),
  )

describe("cloud concurrent transactions", () => {
  beforeEach(() => {
    sequences.length = 0
    executions.length = 0
    requests.length = 0
    batches.length = 0
    batchFailureMessage = undefined
    batchFailuresRemaining = undefined
    foreignKeysOnFailures = 0
    foreignKeysOnFailureMessage = "failed to restore foreign keys"
    refreshAuthTokenCalls = 0
    beginBusyFailures = 0
    commitBusyFailures = 0
    commitConflictFailures = 0
    closeCalls = 0
    transactionCloseCalls = 0
    executeFailure = undefined
  })

  describe("statement error diagnostics", () => {
    const blockedReadsError = () =>
      Object.assign(
        new Error(
          "Operation was blocked: SQL read operations are forbidden (reads are blocked, do you need to upgrade your plan?)",
        ),
        { name: "DatabaseError", code: "BLOCKED" },
      )

    const runFailingStatement = () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* Effect.flip(sql.unsafe("SELECT 1"))
        }).pipe(Effect.provide(makeTestLayer(undefined))),
      )

    it.each([
      blockedReadsError(),
      new Error("Request failed", { cause: blockedReadsError() }),
      new Error("SQL read operations are forbidden"),
      new Error("reads are blocked"),
    ])("explains read blocking through the cause chain: %s", async (cause) => {
      executeFailure = cause

      const error = await runFailingStatement()

      expect(error.message).toContain("Turso blocked SQL reads")
      expect(error.message).toContain("check Turso usage and plan settings")
      expect(error.cause).toBeInstanceOf(Error)
      if (error.cause instanceof Error) {
        expect(error.cause.cause).toBe(cause)
      }
    })

    it.each([
      new Error("no such table: pf_thing"),
      Object.assign(new Error("SQL write operations are forbidden"), {
        code: "BLOCKED",
      }),
      Object.assign(new Error("Operation was blocked"), { code: "BLOCKED" }),
      new Error("Request failed", {
        cause: Object.assign(new Error("SQL write operations are forbidden"), {
          code: "BLOCKED",
        }),
      }),
    ])(
      "leaves errors without read-block evidence unchanged: %s",
      async (cause) => {
        executeFailure = cause

        const error = await runFailingStatement()

        expect(error.message).toBe("Failed to execute statement")
        expect(String(error.cause)).toContain(cause.message)
      },
    )
  })

  it("executes an atomic SQL batch in one serverless-driver request", async () => {
    const statements = [
      "CREATE TABLE parent (id INTEGER PRIMARY KEY)",
      "INSERT INTO parent VALUES (1)",
    ]

    await Effect.runPromise(
      Effect.gen(function* () {
        const batch = yield* TursoCloudBatch
        yield* batch.execute({ statements, foreignKeys: "enforced" })
      }).pipe(Effect.provide(makeTestLayer(undefined))),
    )

    expect(executions).toEqual(["PRAGMA foreign_keys = ON"])
    expect(requests).toEqual(["execute:PRAGMA foreign_keys = ON", "batch"])
    expect(batches).toEqual([{ statements, mode: "immediate" }])
  })

  it("disables foreign keys outside the atomic batch and restores them", async () => {
    const statements = [
      "INSERT INTO child VALUES (1, 1)",
      "INSERT INTO parent VALUES (1)",
    ]

    await Effect.runPromise(
      Effect.gen(function* () {
        const batch = yield* TursoCloudBatch
        yield* batch.execute({
          statements,
          foreignKeys: "disabled-during-batch",
        })
      }).pipe(Effect.provide(makeTestLayer(undefined))),
    )

    expect(requests).toEqual([
      "execute:PRAGMA foreign_keys = OFF",
      "batch",
      "execute:PRAGMA foreign_keys = ON",
    ])
    expect(batches).toEqual([{ statements, mode: "immediate" }])
  })

  it("restores foreign keys when an atomic batch fails", async () => {
    batchFailureMessage = "replay failed"

    const replay = Effect.runPromise(
      Effect.gen(function* () {
        const batch = yield* TursoCloudBatch
        yield* batch.execute({
          statements: ["INVALID"],
          foreignKeys: "disabled-during-batch",
        })
      }).pipe(Effect.provide(makeTestLayer(undefined))),
    )

    await expect(replay).rejects.toThrow("Failed to execute batch")
    expect(requests).toEqual([
      "execute:PRAGMA foreign_keys = OFF",
      "batch",
      "execute:PRAGMA foreign_keys = ON",
    ])
  })

  it("re-enables foreign keys after a restoration request fails", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const batch = yield* TursoCloudBatch
        yield* sql.unsafe("SELECT 1")
        foreignKeysOnFailures = 1
        const batchError = yield* batch
          .execute({
            statements: ["INSERT INTO parent VALUES (1)"],
            foreignKeys: "disabled-during-batch",
          })
          .pipe(Effect.flip)
        yield* sql.unsafe("SELECT 2")
        return batchError
      }).pipe(Effect.provide(makeTestLayer(undefined))),
    )

    expect(error.message).toBe("Failed to restore foreign keys")
    expect(requests).toEqual([
      "execute:PRAGMA foreign_keys = ON",
      "execute:SELECT 1",
      "execute:PRAGMA foreign_keys = OFF",
      "batch",
      "execute:PRAGMA foreign_keys = ON",
      "execute:PRAGMA foreign_keys = ON",
      "execute:SELECT 2",
    ])
  })

  it("retries only foreign-key restoration after a transient lock", async () => {
    foreignKeysOnFailures = 1
    foreignKeysOnFailureMessage = "SQLITE_BUSY: database is locked"

    await runOnTestClock(
      Effect.gen(function* () {
        const batch = yield* TursoCloudBatch
        yield* batch.execute({
          statements: ["INSERT INTO parent VALUES (1)"],
          foreignKeys: "disabled-during-batch",
        })
      }),
      makeTestLayer(undefined),
    )

    expect(requests).toEqual([
      "execute:PRAGMA foreign_keys = OFF",
      "batch",
      "execute:PRAGMA foreign_keys = ON",
      "execute:PRAGMA foreign_keys = ON",
    ])
    expect(batches).toHaveLength(1)
  })

  it("retries a batch after a transient pre-commit lock", async () => {
    batchFailureMessage = "SQLITE_BUSY: database is locked"
    batchFailuresRemaining = 1

    await Effect.runPromise(
      Effect.gen(function* () {
        const batch = yield* TursoCloudBatch
        yield* batch.execute({
          statements: ["INSERT INTO parent VALUES (1)"],
          foreignKeys: "disabled-during-batch",
        })
      }).pipe(Effect.provide(makeTestLayer(undefined))),
    )

    expect(requests).toEqual([
      "execute:PRAGMA foreign_keys = OFF",
      "batch",
      "execute:PRAGMA foreign_keys = OFF",
      "batch",
      "execute:PRAGMA foreign_keys = ON",
    ])
    expect(batches).toHaveLength(2)
  })

  it("surfaces a batch write-write conflict without replaying it", async () => {
    batchFailureMessage = "Tursodb error: Write-write conflict"

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const batch = yield* TursoCloudBatch
        yield* batch.execute({
          statements: ["INSERT INTO replay_items VALUES (1)"],
          foreignKeys: "disabled-during-batch",
        })
      }).pipe(
        Effect.provide(
          makeTestLayer(undefined, {
            authToken: Redacted.make("initial-token"),
            refreshAuthToken: Effect.sync(() => {
              refreshAuthTokenCalls += 1
              return Redacted.make("rotated-token")
            }),
          }),
        ),
        Effect.flip,
      ),
    )

    expect(isSqlWriteWriteConflictError(error)).toBe(true)
    expect(refreshAuthTokenCalls).toBe(0)
    expect(requests).toEqual([
      "execute:PRAGMA foreign_keys = OFF",
      "batch",
      "execute:PRAGMA foreign_keys = ON",
    ])
    expect(batches).toHaveLength(1)
  })

  it("preserves a batch conflict when foreign-key restoration also fails", async () => {
    batchFailureMessage = "Tursodb error: Write-write conflict"
    foreignKeysOnFailures = 1

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const batch = yield* TursoCloudBatch
        yield* batch.execute({
          statements: ["INSERT INTO replay_items VALUES (1)"],
          foreignKeys: "disabled-during-batch",
        })
      }).pipe(Effect.provide(makeTestLayer(undefined)), Effect.flip),
    )

    expect(isSqlWriteWriteConflictError(error)).toBe(true)
    expect(String(error.cause)).toContain("failed to restore foreign keys")
    expect(requests).toEqual([
      "execute:PRAGMA foreign_keys = OFF",
      "batch",
      "execute:PRAGMA foreign_keys = ON",
    ])
    expect(batches).toHaveLength(1)
  })

  it("uses BEGIN CONCURRENT when the opt-in flag is enabled", async () => {
    const mode = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* withConcurrentTransaction(sql, getTransactionMode)
      }).pipe(Effect.provide(makeTestLayer("1"))),
    )

    expect(sequences).toEqual(["BEGIN CONCURRENT", "COMMIT"])
    expect(mode).toBe("concurrent")
    expect(closeCalls).toBe(2)
    expect(transactionCloseCalls).toBe(1)
  })

  it("falls back to BEGIN IMMEDIATE when the opt-in flag is absent", async () => {
    const mode = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* withConcurrentTransaction(sql, getTransactionMode)
      }).pipe(Effect.provide(makeTestLayer(undefined))),
    )

    expect(sequences).toEqual(["BEGIN IMMEDIATE", "COMMIT"])
    expect(mode).toBe("immediate")
  })

  it("falls back to BEGIN IMMEDIATE when the opt-in flag is off", async () => {
    await runTransaction("0", { deferredTransactions: true })

    expect(sequences).toEqual(["BEGIN IMMEDIATE", "COMMIT"])
  })

  it("leaves ordinary transaction begin modes unchanged", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql.withTransaction(Effect.void)
      }).pipe(
        Effect.provide(makeTestLayer("1", { deferredTransactions: true })),
      ),
    )

    expect(sequences).toEqual(["BEGIN DEFERRED", "COMMIT"])
  })

  it("preserves bounded BEGIN lock retries", async () => {
    beginBusyFailures = 1

    await runTransaction("1")

    expect(sequences).toEqual([
      "BEGIN CONCURRENT",
      "BEGIN CONCURRENT",
      "COMMIT",
    ])
  })

  it("preserves bounded COMMIT lock retries without replaying the body", async () => {
    commitBusyFailures = 1
    let bodyExecutions = 0

    await runOnTestClock(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* withConcurrentTransaction(
          sql,
          Effect.sync(() => {
            bodyExecutions += 1
          }),
        )
      }),
      makeTestLayer("1"),
    )

    expect(sequences).toEqual(["BEGIN CONCURRENT", "COMMIT", "COMMIT"])
    expect(bodyExecutions).toBe(1)
  })

  it("replays the whole transaction for write-write commit conflicts", async () => {
    commitConflictFailures = 4
    let bodyExecutions = 0

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* withConcurrentTransaction(
          sql,
          Effect.sync(() => {
            bodyExecutions += 1
          }),
        ).pipe(
          Effect.retry({
            schedule: Schedule.recurs(4),
            while: isSqlLockError,
          }),
        )
      }).pipe(Effect.provide(makeTestLayer("1"))),
    )

    expect(bodyExecutions).toBe(5)
    expect(sequences.filter((sql) => sql === "BEGIN CONCURRENT")).toHaveLength(
      5,
    )
    expect(sequences.filter((sql) => sql === "COMMIT")).toHaveLength(5)
    expect(sequences.filter((sql) => sql === "ROLLBACK")).toHaveLength(4)
    expect(transactionCloseCalls).toBe(5)
  })

  it("does not swallow an outer commit failure after a nested concurrent request", async () => {
    commitConflictFailures = 1

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql.withTransaction(withConcurrentTransaction(sql, Effect.void))
      }).pipe(
        Effect.provide(makeTestLayer("1", { deferredTransactions: true })),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(sequences).toEqual(["BEGIN DEFERRED", "COMMIT", "ROLLBACK"])
    expect(transactionCloseCalls).toBe(1)
  })

  it("returns an exhausted concurrent COMMIT failure for semantic retry", async () => {
    commitBusyFailures = 6
    let bodyExecutions = 0

    const error = await runOnTestClock(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* withConcurrentTransaction(
          sql,
          Effect.sync(() => {
            bodyExecutions += 1
          }),
        )
      }).pipe(Effect.flip),
      makeTestLayer("1"),
    )

    expect(error).toBeInstanceOf(SqlError)
    expect(sequences).toEqual([
      "BEGIN CONCURRENT",
      "COMMIT",
      "COMMIT",
      "COMMIT",
      "COMMIT",
      "COMMIT",
      "COMMIT",
      "ROLLBACK",
    ])
    expect(bodyExecutions).toBe(1)
    expect(closeCalls).toBe(2)
    expect(transactionCloseCalls).toBe(1)
  })
})
