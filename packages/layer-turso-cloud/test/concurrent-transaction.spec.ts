import {
  ConfigProvider,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Redacted,
  Schedule,
  Tracer,
} from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { SqlError } from "effect/sql/SqlError"
import * as Statement from "effect/sql/Statement"
import { TestClock } from "effect/testing"
import {
  concurrentTransactionRequested,
  getTransactionMode,
  immediateTransactionRequested,
  isSqlLockError,
  isSqlWriteWriteConflictError,
  readSnapshotRequested,
  withConcurrentTransaction,
  withImmediateTransaction,
  withReadSnapshot,
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
let beginFailure: { readonly message: string; remaining: number } | undefined
let commitBusyFailures = 0
let commitConflictFailures = 0
let rollbackFailures = 0
let closeCalls = 0
let transactionCloseCalls = 0
let sessionsCreated = 0
const sessionAuthTokens: Array<string | undefined> = []
let executeFailure: Error | undefined
let executeFailuresRemaining: number | undefined

const emptyResult = {
  columns: [],
  columnTypes: [],
  rows: [],
  rowsAffected: 0,
}

mock.module("@tursodatabase/serverless", () => ({
  Session: class {
    private isTransaction = false

    constructor(options?: { readonly authToken?: string }) {
      sessionsCreated += 1
      sessionAuthTokens.push(options?.authToken)
    }

    execute(sql: string, _params: ReadonlyArray<unknown>) {
      executions.push(sql)
      requests.push(`execute:${sql}`)
      if (sql === "PRAGMA foreign_keys = ON" && foreignKeysOnFailures > 0) {
        foreignKeysOnFailures -= 1
        return Promise.reject(new Error(foreignKeysOnFailureMessage))
      }
      if (
        sql !== "PRAGMA foreign_keys = ON" &&
        executeFailure &&
        executeFailuresRemaining !== 0
      ) {
        if (executeFailuresRemaining !== undefined) {
          executeFailuresRemaining -= 1
        }
        return Promise.reject(executeFailure)
      }
      return Promise.resolve(emptyResult)
    }

    async batch(
      statements: ReadonlyArray<string | { sql: string; args: unknown[] }>,
      mode?: string,
    ) {
      if (mode === undefined) {
        const results = []
        for (const statement of statements) {
          const sql = typeof statement === "string" ? statement : statement.sql
          results.push(
            sql.startsWith("BEGIN ")
              ? await this.sequence(sql)
              : await this.execute(sql, []),
          )
        }
        return results
      }
      batches.push({
        statements: statements.map((s) => (typeof s === "string" ? s : s.sql)),
        mode,
      })
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

      if (
        sql.startsWith("BEGIN ") &&
        beginFailure !== undefined &&
        beginFailure.remaining > 0
      ) {
        beginFailure.remaining -= 1
        return Promise.reject(new Error(beginFailure.message))
      }

      if (sql === "ROLLBACK" && rollbackFailures > 0) {
        rollbackFailures -= 1
        return Promise.reject(new Error("failed to rollback"))
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

  const configLayer = ConfigProvider.layer(
    ConfigProvider.fromUnknown(Object.fromEntries(values)),
  )
  return makeTursoCloudLive(options).pipe(Layer.provide(configLayer))
}

const runOnTestClock = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  layer: Layer.Layer<R>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(effect)
      yield* TestClock.adjust("10 seconds")
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer())),
  )

const captureTelemetry = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const spans: Tracer.NativeSpan[] = []
  const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  return {
    spans,
    logs,
    effect: effect.pipe(
      Effect.withSpan("caller"),
      Effect.provideService(
        Tracer.Tracer,
        Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options)
            spans.push(span)
            return span
          },
        }),
      ),
      Effect.provide(
        Logger.layer([
          Logger.make((options) => {
            logs.push(Logger.formatStructured.log(options))
          }),
        ]),
      ),
    ),
  }
}

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
    beginFailure = undefined
    commitBusyFailures = 0
    commitConflictFailures = 0
    rollbackFailures = 0
    closeCalls = 0
    transactionCloseCalls = 0
    sessionsCreated = 0
    sessionAuthTokens.length = 0
    executeFailure = undefined
    executeFailuresRemaining = undefined
  })

  it.each([
    { failures: 0, failureKind: "SQLITE_BUSY", propagate: true },
    { failures: 2, failureKind: "SQLITE_BUSY", propagate: true },
    { failures: 2, failureKind: "SQLITE_LOCKED", propagate: false },
    { failures: 100, failureKind: "SQLITE_BUSY", propagate: true },
    { failures: 100, failureKind: "constraint failed", propagate: true },
  ])(
    "records bounded statement retry telemetry (%j)",
    async ({ failures, failureKind, propagate }) => {
      const url = "libsql://test.turso.io"
      const token = "retry-test-secret-token"
      const parameter = "retry-test-private-parameter"
      const payload = "retry-test-raw-server-payload"
      const failure = new Error(
        `${failureKind}: ${url} ${token} ${parameter} ${payload}`,
      )
      executeFailure = failure
      executeFailuresRemaining = failures
      const query = "SELECT ? AS retry_probe"
      const expectedRetries =
        failureKind === "constraint failed" ? 0 : Math.min(failures, 5)
      const fails = failures > expectedRetries
      const telemetry = captureTelemetry(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const outcome = yield* sql.unsafe(query, [parameter]).pipe(
            Effect.match({
              onSuccess: (rows) => rows,
              onFailure: (error) => error,
            }),
          )
          executeFailuresRemaining = 0
          yield* sql.unsafe("SELECT 1 AS normal_probe")
          return outcome
        }).pipe(
          Effect.provideService(Statement.SpanPropagationEnabled, propagate),
        ),
      )
      const outcome = await runOnTestClock(
        telemetry.effect,
        makeTestLayer("1", { authToken: Redacted.make(token) }),
      )
      expect(executions.filter((sql) => sql === query)).toHaveLength(
        expectedRetries + 1,
      )
      if (fails) {
        expect(outcome).toBeInstanceOf(SqlError)
        if (outcome instanceof SqlError) {
          const cause = outcome.reason.cause
          expect(cause instanceof Error ? cause.cause : undefined).toBe(failure)
        }
      } else {
        expect(outcome).toEqual([])
      }

      const activeSpan = telemetry.spans.find((span) =>
        propagate
          ? span.attributes.get("db.query.text") === query
          : span.name === "caller",
      )!
      const events = activeSpan.events.filter(
        ([name]) => name === "turso.lock_retry",
      )
      expect(events).toHaveLength(expectedRetries)
      expect(
        telemetry.spans.flatMap((span) =>
          span.events.filter(([name]) => name === "turso.lock_retry"),
        ),
      ).toHaveLength(expectedRetries)
      expect(activeSpan.attributes.get("turso.retry.attempt_count")).toBe(
        expectedRetries > 0 ? expectedRetries + 1 : undefined,
      )
      for (const [index, [, timestamp, attributes]] of events.entries()) {
        expect(attributes).toEqual({
          "turso.retry.attempt": index + 1,
          "turso.retry.failure_kind": "lock/busy",
          "turso.retry.delay_ms": expect.any(Number),
        })
        const delay = Number(attributes["turso.retry.delay_ms"])
        expect(delay).toBeGreaterThanOrEqual(100 * 2 ** index * 0.8)
        expect(delay).toBeLessThanOrEqual(100 * 2 ** index * 1.2)
        const nextTimestamp =
          events[index + 1]?.[1] ??
          (activeSpan.status._tag === "Ended"
            ? activeSpan.status.endTime
            : undefined)
        expect(Number(nextTimestamp! - timestamp) / 1e6).toBeCloseTo(delay, 5)
      }
      const normalSpan = telemetry.spans.find(
        (span) =>
          span.attributes.get("db.query.text") === "SELECT 1 AS normal_probe",
      )!
      expect(normalSpan.attributes.has("turso.retry.attempt_count")).toBe(false)
      expect(telemetry.logs).toHaveLength(expectedRetries === 5 ? 1 : 0)
      if (expectedRetries === 5) {
        expect(telemetry.logs[0]).toMatchObject({
          level: "WARN",
          message: "Turso lock retries exhausted",
          cause: undefined,
          annotations: {
            "turso.retry.attempt_count": 6,
            "turso.retry.failure_kind": "lock/busy",
          },
        })
      }
      const recorded = JSON.stringify({
        spans: telemetry.spans.map((span) => ({
          attributes: Object.fromEntries(span.attributes),
          events: span.events.map(([name, , attributes]) => ({
            name,
            attributes,
          })),
        })),
        logs: telemetry.logs,
      })
      for (const secret of [url, token, parameter, payload]) {
        expect(recorded).not.toContain(secret)
      }
    },
  )

  it.each([undefined, "0", "1"])(
    "explicit immediate overrides deferred defaults and concurrent requests (flag=%s)",
    async (flag) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* withImmediateTransaction(sql, sql.unsafe("SELECT 1")).pipe(
            Effect.provideService(concurrentTransactionRequested, true),
          )
          yield* sql.withTransaction(sql.unsafe("SELECT 2"))
          yield* withImmediateTransaction(sql, sql.unsafe("SELECT 3")).pipe(
            Effect.provideService(readSnapshotRequested, true),
          )
          expect(
            yield* withConcurrentTransaction(sql, getTransactionMode).pipe(
              Effect.provideService(immediateTransactionRequested, true),
            ),
          ).toBe("immediate")
        }).pipe(
          Effect.provide(makeTestLayer(flag, { deferredTransactions: true })),
        ),
      )
      expect(sequences).toEqual([
        "BEGIN IMMEDIATE",
        "COMMIT",
        "BEGIN DEFERRED",
        "COMMIT",
        "BEGIN DEFERRED",
        "COMMIT",
        "BEGIN IMMEDIATE",
        "COMMIT",
      ])
    },
  )

  it("does not upgrade an outer snapshot for a nested immediate request", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* withReadSnapshot(
          sql,
          withImmediateTransaction(sql, sql.unsafe("SELECT 1")),
        )
      }).pipe(Effect.provide(makeTestLayer("1"))),
    )
    expect(sequences).toEqual(["BEGIN DEFERRED", "COMMIT"])
    expect(executions).toContain("SAVEPOINT effect_sql_1;")
  })

  it("bounds immediate begin retries without executing the body", async () => {
    beginBusyFailures = 100
    let bodyRuns = 0
    const telemetry = captureTelemetry(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* Effect.flip(
          withImmediateTransaction(
            sql,
            Effect.sync(() => {
              bodyRuns += 1
            }),
          ),
        )
      }),
    )
    const error = await runOnTestClock(telemetry.effect, makeTestLayer("1"))
    expect(isSqlLockError(error)).toBe(true)
    expect(bodyRuns).toBe(0)
    expect(sequences).toEqual(Array(6).fill("BEGIN IMMEDIATE"))
    expect(transactionCloseCalls).toBe(6)
    const caller = telemetry.spans.find(
      (span) => span.name === "sql.transaction",
    )!
    expect(
      caller.events.filter(([name]) => name === "turso.lock_retry"),
    ).toHaveLength(5)
    expect(caller.attributes.get("turso.retry.attempt_count")).toBe(6)
    expect(telemetry.logs).toHaveLength(1)
  })

  it.each([undefined, "1"])(
    "uses deferred read snapshots without changing subsequent writes (concurrent=%s)",
    async (flag) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* withReadSnapshot(sql, sql.unsafe("SELECT 1"))
          yield* sql.withTransaction(sql.unsafe("SELECT 2"))
        }).pipe(Effect.provide(makeTestLayer(flag))),
      )
      expect(sequences).toEqual([
        "BEGIN DEFERRED",
        "COMMIT",
        "BEGIN IMMEDIATE",
        "COMMIT",
      ])
    },
  )

  it("rolls back a failed snapshot and allows the next operation", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const result = yield* Effect.result(
          withReadSnapshot(sql, Effect.fail("failed read")),
        )
        expect(result._tag).toBe("Failure")
        yield* sql.withTransaction(sql.unsafe("SELECT 1"))
      }).pipe(Effect.provide(makeTestLayer(undefined))),
    )
    expect(sequences).toEqual([
      "BEGIN DEFERRED",
      "ROLLBACK",
      "BEGIN IMMEDIATE",
      "COMMIT",
    ])
  })

  it("reuses an outer write transaction for nested snapshot reads", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql.withTransaction(
          withReadSnapshot(sql, sql.unsafe("SELECT 1")),
        )
      }).pipe(Effect.provide(makeTestLayer(undefined))),
    )
    expect(sequences).toEqual(["BEGIN IMMEDIATE", "COMMIT"])
    expect(executions).toContain("SAVEPOINT effect_sql_1;")
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
      expect(error.reason.cause).toBeInstanceOf(Error)
      if (error.reason.cause instanceof Error) {
        expect(error.reason.cause.cause).toBe(cause)
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
        expect(String(error.reason.cause)).toContain(cause.message)
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

  it("allows other statements during an enforced batch's lock backoff", async () => {
    batchFailureMessage = "SQLITE_BUSY: database is locked"
    batchFailuresRemaining = 1

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const batch = yield* TursoCloudBatch
        const batchFiber = yield* Effect.forkChild(
          batch.execute({
            statements: ["INSERT INTO parent VALUES (1)"],
            foreignKeys: "enforced",
          }),
        )
        yield* TestClock.adjust("0 millis")
        expect(batches).toHaveLength(1)

        const readFiber = yield* Effect.forkChild(sql.unsafe("SELECT 42"))
        yield* TestClock.adjust("0 millis")
        const readDuringBackoff = executions.includes("SELECT 42")
        expect(batches).toHaveLength(1)

        yield* TestClock.adjust("10 seconds")
        yield* Fiber.join(readFiber)
        yield* Fiber.join(batchFiber)
        expect(readDuringBackoff).toBe(true)
        expect(batches).toHaveLength(2)
      }).pipe(
        Effect.provide(makeTestLayer(undefined)),
        Effect.provide(TestClock.layer()),
      ),
    )
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
    expect(String(error.reason.cause)).toContain(
      "failed to restore foreign keys",
    )
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

    const telemetry = captureTelemetry(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* withConcurrentTransaction(
          sql,
          Effect.sync(() => {
            bodyExecutions += 1
          }),
        )
      }),
    )
    await runOnTestClock(telemetry.effect, makeTestLayer("1"))

    expect(sequences).toEqual(["BEGIN CONCURRENT", "COMMIT", "COMMIT"])
    expect(bodyExecutions).toBe(1)
    const caller = telemetry.spans.find((span) => span.name === "caller")!
    expect(
      caller.events.filter(([name]) => name === "turso.lock_retry"),
    ).toHaveLength(1)
    expect(caller.attributes.get("turso.retry.attempt_count")).toBe(2)
    expect(telemetry.logs).toEqual([])
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

    const telemetry = captureTelemetry(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql.withTransaction(withConcurrentTransaction(sql, Effect.void))
      }).pipe(
        Effect.provide(makeTestLayer("1", { deferredTransactions: true })),
      ),
    )
    const exit = await Effect.runPromiseExit(telemetry.effect)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(sequences).toEqual(["BEGIN DEFERRED", "COMMIT", "ROLLBACK"])
    expect(transactionCloseCalls).toBe(1)
    expect(
      telemetry.spans.flatMap((span) =>
        span.events.filter(([name]) => name === "turso.lock_retry"),
      ),
    ).toEqual([])
    expect(telemetry.logs).toEqual([])
  })

  it("returns an exhausted concurrent COMMIT failure for semantic retry", async () => {
    commitBusyFailures = 6
    let bodyExecutions = 0

    const telemetry = captureTelemetry(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* withConcurrentTransaction(
          sql,
          Effect.sync(() => {
            bodyExecutions += 1
          }),
        )
      }).pipe(Effect.flip),
    )
    const error = await runOnTestClock(telemetry.effect, makeTestLayer("1"))

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
    const caller = telemetry.spans.find((span) => span.name === "caller")!
    expect(
      caller.events.filter(([name]) => name === "turso.lock_retry"),
    ).toHaveLength(5)
    expect(caller.attributes.get("turso.retry.attempt_count")).toBe(6)
    expect(telemetry.logs).toHaveLength(1)
  })

  describe("transaction session reuse", () => {
    it("reuses one transaction session across sequential writes", async () => {
      let closesDuringWrites = 0
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          for (const id of [1, 2, 3]) {
            yield* sql.withTransaction(sql.unsafe("SELECT ?", [id]))
          }
          closesDuringWrites = closeCalls
          // The base read session plus one lazily created transaction session.
          expect(sessionsCreated).toBe(2)
        }).pipe(Effect.provide(makeTestLayer(undefined))),
      )

      expect(closesDuringWrites).toBe(0)
      // The transaction session closes with the layer scope, not per transaction.
      expect(transactionCloseCalls).toBe(1)
      expect(closeCalls).toBe(2)
    })

    it("queues overlapping transactions on the shared session", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* Effect.all(
            [
              sql.withTransaction(sql.unsafe("SELECT 1")),
              sql.withTransaction(sql.unsafe("SELECT 2")),
            ],
            { concurrency: 2 },
          )
          // Base read session plus the one transaction session they share.
          expect(sessionsCreated).toBe(2)
        }).pipe(Effect.provide(makeTestLayer(undefined))),
      )

      // The second transaction waits for the first to commit instead of
      // contending for the same session.
      expect(sequences).toEqual([
        "BEGIN IMMEDIATE",
        "COMMIT",
        "BEGIN IMMEDIATE",
        "COMMIT",
      ])
      expect(transactionCloseCalls).toBe(1)
    })

    it("cancels a queued transaction before BEGIN and releases the baton", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const holderStarted = yield* Deferred.make<void>()
          const releaseHolder = yield* Deferred.make<void>()
          const holder = yield* Effect.forkChild(
            sql.withTransaction(
              Effect.gen(function* () {
                yield* Deferred.succeed(holderStarted, undefined)
                yield* Deferred.await(releaseHolder)
              }),
            ),
          )

          yield* Deferred.await(holderStarted)
          const queued = yield* Effect.forkChild(
            sql.withTransaction(sql.unsafe("SELECT 1")),
          )
          yield* Effect.yieldNow
          // Taking the lease is atomic, but the restored BEGIN observes the
          // pending interrupt before opening a transaction.
          const interrupt = yield* Effect.forkChild(Fiber.interrupt(queued))

          yield* Deferred.succeed(releaseHolder, undefined)
          yield* Fiber.join(holder)
          yield* Fiber.join(interrupt)

          // Cancelling a waiter leaves the baton free for the next write.
          yield* sql.withTransaction(sql.unsafe("SELECT 2"))
        }).pipe(Effect.provide(makeTestLayer(undefined))),
      )

      expect(
        sequences.filter((entry) => entry === "BEGIN IMMEDIATE"),
      ).toHaveLength(2)
      expect(sequences.filter((entry) => entry === "ROLLBACK")).toHaveLength(0)
      expect(sequences.filter((entry) => entry === "COMMIT")).toHaveLength(2)
    })

    it("drops the per-write session close round trip", async () => {
      const roundTrips: number[] = []
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          for (const id of [1, 2]) {
            const before = requests.length + sequences.length + closeCalls
            yield* sql.withTransaction(sql.unsafe("SELECT ?", [id]))
            roundTrips.push(
              requests.length + sequences.length + closeCalls - before,
            )
          }
        }).pipe(Effect.provide(makeTestLayer(undefined))),
      )

      // The stub counts the PRAGMA step, BEGIN, the statement, and COMMIT
      // separately, so a write is four entries and a per-transaction session
      // added its `close()` on top.
      expect(roundTrips).toEqual([4, 4])
      expect(sequences).toEqual([
        "BEGIN IMMEDIATE",
        "COMMIT",
        "BEGIN IMMEDIATE",
        "COMMIT",
      ])
    })

    it("does not block reads behind an open transaction", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const order: string[] = []
          const transactionStarted = yield* Deferred.make<void>()
          const readCompleted = yield* Deferred.make<void>()
          const read = yield* Effect.forkChild(
            Effect.gen(function* () {
              yield* Deferred.await(transactionStarted)
              yield* sql.unsafe("SELECT 41")
              order.push("read")
              yield* Deferred.succeed(readCompleted, undefined)
            }),
          )

          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql.unsafe("SELECT 42")
              yield* Deferred.succeed(transactionStarted, undefined)
              // Reads use the base session; a queued read would never arrive.
              yield* Deferred.await(readCompleted)
              order.push("commit")
            }),
          )
          yield* Fiber.join(read)
          expect(order).toEqual(["read", "commit"])
        }).pipe(Effect.provide(makeTestLayer(undefined))),
      )
    })

    it("discards the transaction session when the auth token rotates", async () => {
      beginFailure = { message: "expired token", remaining: 1 }

      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql.withTransaction(sql.unsafe("SELECT 1"))
          yield* sql.withTransaction(sql.unsafe("SELECT 2"))
        }).pipe(
          Effect.provide(
            makeTestLayer(undefined, {
              authToken: Redacted.make("token-1"),
              refreshAuthToken: Effect.succeed(Redacted.make("token-2")),
            }),
          ),
        ),
      )

      // Base session, first transaction session, refreshed base session, and
      // the replacement transaction session; the stale one is never reused and
      // the second write reuses the replacement session.
      expect(sessionAuthTokens).toEqual([
        "token-1",
        "token-1",
        "token-2",
        "token-2",
      ])
      expect(sessionsCreated).toBe(4)
      expect(transactionCloseCalls).toBe(2)
      expect(sequences).toEqual([
        "BEGIN IMMEDIATE",
        "BEGIN IMMEDIATE",
        "COMMIT",
        "BEGIN IMMEDIATE",
        "COMMIT",
      ])
    })

    it("discards the transaction session after an HTTP 404 begin", async () => {
      beginFailure = { message: "HTTP error! status: 404", remaining: 1 }

      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql.withTransaction(sql.unsafe("SELECT 1"))
        }).pipe(Effect.provide(makeTestLayer(undefined))),
      )

      // Base session, discarded transaction session, replacement transaction
      // session. The 404 came from the transaction session, so the shared read
      // session is neither recreated nor closed.
      expect(sessionsCreated).toBe(3)
      expect(transactionCloseCalls).toBe(2)
      expect(closeCalls - transactionCloseCalls).toBe(1)
      expect(sequences).toEqual([
        "BEGIN IMMEDIATE",
        "BEGIN IMMEDIATE",
        "COMMIT",
      ])
    })

    it("keeps the read session usable when a stale transaction session returns 404", async () => {
      beginFailure = { message: "HTTP error! status: 404", remaining: 1 }

      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const readBefore = yield* sql.unsafe("SELECT 40")
          expect(readBefore).toEqual([])
          yield* sql.withTransaction(sql.unsafe("SELECT 1"))
          expect(yield* sql.unsafe("SELECT 41")).toEqual([])
        }).pipe(Effect.provide(makeTestLayer(undefined))),
      )

      // Only the transaction session paid for the 404; the read session stays.
      expect(executions.filter((sql) => sql === "SELECT 40")).toHaveLength(1)
      expect(executions.filter((sql) => sql === "SELECT 41")).toHaveLength(1)
      expect(closeCalls - transactionCloseCalls).toBe(1)
    })

    it("discards the transaction session when rollback fails", async () => {
      rollbackFailures = 1
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const failed = yield* Effect.exit(
            sql.withTransaction(Effect.fail("failed body")),
          )
          const sessionsBeforeNextWrite = sessionsCreated
          yield* sql.withTransaction(sql.unsafe("SELECT 1"))
          return { failed: Exit.isFailure(failed), sessionsBeforeNextWrite }
        }).pipe(Effect.provide(makeTestLayer(undefined))),
      )

      expect(result.failed).toBe(true)
      expect(sessionsCreated).toBe(result.sessionsBeforeNextWrite + 1)
      expect(sequences).toEqual([
        "BEGIN IMMEDIATE",
        "ROLLBACK",
        "BEGIN IMMEDIATE",
        "COMMIT",
      ])
    })

    it("discards the session after an interrupted transaction but still rolls back", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const bodyStarted = yield* Deferred.make<void>()
          const fiber = yield* Effect.forkChild(
            sql.withTransaction(
              Effect.gen(function* () {
                yield* sql.unsafe("INSERT INTO parent VALUES (1)")
                yield* Deferred.succeed(bodyStarted, undefined)
                yield* Effect.never
              }),
            ),
          )

          yield* Deferred.await(bodyStarted)
          yield* Fiber.interrupt(fiber)
          // The rollback still reaches the server, but the session is discarded.
          expect(sequences).toEqual(["BEGIN IMMEDIATE", "ROLLBACK"])
          const sessionsBeforeNextWrite = sessionsCreated
          yield* sql.withTransaction(sql.unsafe("SELECT 1"))
          expect(sessionsCreated).toBe(sessionsBeforeNextWrite + 1)
        }).pipe(Effect.provide(makeTestLayer(undefined))),
      )

      expect(transactionCloseCalls).toBe(2)
    })
  })
})
