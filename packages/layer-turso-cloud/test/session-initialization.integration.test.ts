import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Session } from "@tursodatabase/serverless"
import {
  ConfigProvider,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Metric,
  Redacted,
  Tracer,
} from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as Statement from "effect/sql/Statement"
import {
  SqlReadBatch,
  SqlReadBatchError,
  getTursoHttpStatus,
} from "@pf/db-info"
import { makeTursoCloudLive } from "../src/index"
import { afterAll, beforeAll, beforeEach, expect, it } from "bun:test"

let directory: string
let daemon: ReturnType<typeof Bun.spawn>
let proxy: ReturnType<typeof Bun.serve>
let backend: string
const requests: string[][] = []
const batons: Array<string | undefined> = []
let failPragma = false
let failHttpStatus: number | undefined
let foreignKeysOff = false
let heldResponse:
  | {
      readonly received: () => void
      readonly release: Promise<void>
    }
  | undefined
let truncateBatchResponse = false
let onSessionClosed: (() => void) | undefined
const spans: Tracer.NativeSpan[] = []
const tracer = Tracer.make({
  span(options) {
    const span = new Tracer.NativeSpan(options)
    spans.push(span)
    return span
  },
})

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "turso-init-"))
  const reserve = Bun.serve({ port: 0, fetch: () => new Response() })
  backend = `http://127.0.0.1:${reserve.port}`
  reserve.stop(true)
  daemon = Bun.spawn(
    ["sqld", "--db-path", directory, "--http-listen-addr", backend.slice(7)],
    { stdout: "ignore", stderr: "ignore" },
  )
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fetch(backend)
      break
    } catch {
      await Bun.sleep(20)
    }
  }
  proxy = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json()
      const batches: Array<{ steps: Array<{ stmt: { sql: string } }> }> =
        body.batch
          ? [body.batch]
          : (body.requests ?? []).flatMap((r: { batch?: unknown }) =>
              r.batch ? [r.batch] : [],
            )
      const sql = batches.flatMap((batch) =>
        batch.steps.map((step: { stmt: { sql: string } }) => step.stmt.sql),
      )
      if (
        sql.length ||
        body.requests?.some((r: { type: string }) => r.type === "sequence")
      ) {
        requests.push(
          sql.length
            ? sql
            : body.requests.map((r: { sql?: string }) => r.sql).filter(Boolean),
        )
        batons.push(body.baton ?? undefined)
      }
      if (failHttpStatus !== undefined && sql.length) {
        const status = failHttpStatus
        failHttpStatus = undefined
        return new Response(null, { status })
      }
      if (failPragma) {
        for (const batch of batches) {
          for (const step of batch.steps) {
            if (step.stmt.sql === "PRAGMA foreign_keys = ON") {
              step.stmt.sql = "SELECT * FROM missing_pragma_failure"
              failPragma = false
            }
          }
        }
      }
      if (foreignKeysOff && !body.baton && sql.length) {
        // Set up an FK-OFF backend session before forwarding the client's first
        // request. These fixture requests are excluded from client request counts.
        const response = await fetch(`${backend}/v3/pipeline`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            baton: null,
            requests: [
              { type: "sequence", sql: "PRAGMA foreign_keys = OFF" },
              {
                type: "execute",
                stmt: {
                  sql: "PRAGMA foreign_keys",
                  args: [],
                  named_args: [],
                  want_rows: true,
                },
              },
            ],
          }),
        })
        const initialized = await response.json()
        expect(initialized.results[1].response.result.rows[0][0].value).toBe(
          "0",
        )
        body.baton = initialized.baton
      }
      // Real backend errors and conditional execution; only transport fault
      // injection lives here. SQL and SDK result decoding are never mocked.
      const response = await fetch(backend + new URL(request.url).pathname, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept-Encoding": "identity",
        },
        body: JSON.stringify(body),
      })
      if (body.requests?.some((r: { type: string }) => r.type === "close")) {
        onSessionClosed?.()
      }
      if (
        heldResponse &&
        body.requests?.some((r: { type: string }) => r.type === "batch")
      ) {
        const held = heldResponse
        heldResponse = undefined
        held.received()
        await held.release
      }
      if (
        truncateBatchResponse &&
        body.requests?.some((r: { type: string }) => r.type === "batch")
      ) {
        truncateBatchResponse = false
        const partial = await response.json()
        partial.results[0].response.result.step_results.pop()
        return Response.json(partial)
      }
      return response
    },
  })
  const setup = new Session({ url: backend })
  await setup.sequence(
    "CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));",
  )
  await setup.close()
})
afterAll(async () => {
  proxy?.stop(true)
  daemon?.kill()
  await daemon?.exited
  if (directory) await rm(directory, { recursive: true, force: true })
})
beforeEach(() => {
  requests.length = 0
  batons.length = 0
  spans.length = 0
  failPragma = false
  failHttpStatus = undefined
  foreignKeysOff = false
  heldResponse = undefined
  truncateBatchResponse = false
  onSessionClosed = undefined
})

const cloudLayer = (options?: Parameters<typeof makeTursoCloudLive>[0]) =>
  makeTursoCloudLive(options).pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          SQLITE_DATABASE_PATH: `http://127.0.0.1:${proxy.port}`,
        }),
      ),
    ),
  )

const run = <A, E>(
  effect: Effect.Effect<A, E, SqlClient.SqlClient | SqlReadBatch>,
  options?: Parameters<typeof makeTursoCloudLive>[0],
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(cloudLayer(options)),
      Effect.withSpan("caller"),
      Effect.provideService(Tracer.Tracer, tracer),
    ),
  )

it("counts successful and failed Turso requests with bounded labels", async () => {
  const counters = await run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe("SELECT 1")
      failHttpStatus = 502
      const upstreamFailure = yield* Effect.flip(sql.unsafe("SELECT 2"))
      expect(getTursoHttpStatus(upstreamFailure)).toBe(502)
      const sqlFailure = yield* Effect.flip(
        sql.unsafe("SELECT * FROM missing_metric_test_table"),
      )
      expect(getTursoHttpStatus(sqlFailure)).toBeUndefined()
      return (yield* Metric.snapshot)
        .filter(
          (snapshot) =>
            snapshot.type === "Counter" && snapshot.id === "pf.turso.requests",
        )
        .map(({ attributes, state }) => ({ attributes, count: state.count }))
    }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())),
    { metricDimensions: { environment: "test" } },
  )

  expect(requests).toHaveLength(3)
  expect(counters).toEqual(
    [
      { operation: "execute", outcome: "ok" },
      { operation: "execute", outcome: "error", "http.status_code": "502" },
      { operation: "execute", outcome: "error", "error.type": "other" },
    ].map((attributes) => ({
      attributes: {
        ...attributes,
        "pf.env": "test",
      },
      count: 1,
    })),
  )
})

it("uses one cold request, keeps complete parameterized results, and serializes concurrent first use", async () => {
  await run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const results = yield* Effect.all(
        [
          sql.unsafe("SELECT ? AS value UNION ALL SELECT ?", [42, 43]).values,
          sql.unsafe("SELECT ? AS value", [44]).values,
        ],
        { concurrency: "unbounded" },
      )
      expect(results).toEqual([[[42], [43]], [[44]]])
      const raw = yield* sql.unsafe("SELECT id FROM parent").raw
      expect(raw).toMatchObject({
        columns: ["id"],
        columnTypes: ["INTEGER"],
        rows: [],
        rowsAffected: 0,
      })
    }),
  )
  expect(requests).toHaveLength(3)
  expect(requests[0]).toEqual([
    "PRAGMA foreign_keys = ON",
    "SELECT ? AS value UNION ALL SELECT ?",
  ])
  expect(
    requests.flat().filter((s) => s === "PRAGMA foreign_keys = ON"),
  ).toHaveLength(1)
  const events = spans.flatMap((s) => s.events)
  expect(
    events.filter(([name]) => name === "turso.session.first_use"),
  ).toHaveLength(1)
  expect(
    spans.map((s) => s.name).filter((name) => name.startsWith("Turso")),
  ).toEqual([])
})

it("preserves cold result metadata, positional columns, blobs, and write counts", async () => {
  await run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const raw = yield* sql.unsafe(
        "SELECT ? AS duplicate, ? AS duplicate, ? AS payload",
        [1, 2, new Uint8Array([3, 4])],
      ).raw
      expect(raw).toMatchObject({
        columns: ["duplicate", "duplicate", "payload"],
        columnTypes: ["", "", ""],
        rowsAffected: 0,
        rows: [[1, 2, Buffer.from([3, 4])]],
      })
    }),
  )
  await run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      expect(
        yield* sql.unsafe("INSERT INTO parent VALUES (?)", [103]).raw,
      ).toMatchObject({ rowsAffected: 1, lastInsertRowid: 103n })
    }),
  )
})

it("preserves RETURNING rows and affected counts in one cold request", async () => {
  await run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const statement = "INSERT INTO parent VALUES (?) RETURNING id"
      const cold = yield* sql.unsafe(statement, [201]).raw
      expect(cold).toMatchObject({
        columns: ["id"],
        columnTypes: ["INTEGER"],
        rows: [[201]],
        rowsAffected: 1,
        lastInsertRowid: 201n,
      })
      expect(requests).toEqual([["PRAGMA foreign_keys = ON", statement]])
      const warm = yield* sql.unsafe(statement, [202]).raw
      expect(warm).toMatchObject({ rows: [[202]], rowsAffected: 1 })
      expect(requests).toHaveLength(2)
    }),
  )
})

it("reuses one transaction session across sequential writes", async () => {
  await run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.withTransaction(
        sql.unsafe("INSERT INTO parent VALUES (?)", [301]),
      )
      yield* sql.withTransaction(
        sql.unsafe("INSERT INTO parent VALUES (?)", [302]),
      )
      expect(
        yield* sql.unsafe("SELECT id FROM parent WHERE id > 300").values,
      ).toEqual([[301], [302]])
    }),
  )
  const beginBatons = requests.flatMap((statements, index) =>
    statements.some((statement) => statement.startsWith("BEGIN "))
      ? [batons[index]]
      : [],
  )
  expect(beginBatons).toHaveLength(2)
  // A fresh session starts its own Hrana stream; a reused one continues the
  // stream its committed transaction left behind.
  expect(beginBatons[0]).toBeUndefined()
  expect(typeof beginBatons[1]).toBe("string")
})

it.each([false, true])(
  "enforces foreign keys before first SQL/BEGIN (transaction=%s)",
  async (transaction) => {
    foreignKeysOff = true
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const insert = sql.unsafe("INSERT INTO child VALUES (?, ?)", [100, -1])
        const error = yield* Effect.flip(
          transaction ? sql.withTransaction(insert) : insert,
        )
        expect(String(error.reason.cause)).toContain("FOREIGN KEY")
        expect(yield* sql.unsafe("SELECT * FROM child").values).toEqual([])
      }),
    )
    expect(requests[0]).toEqual([
      "PRAGMA foreign_keys = ON",
      transaction ? "BEGIN IMMEDIATE" : "INSERT INTO child VALUES (?, ?)",
    ])
  },
)

it.each([false, true])(
  "batches ordered parameterized reads in one request (warm=%s)",
  async (warm) => {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const batch = yield* SqlReadBatch
        if (warm) yield* sql.unsafe("SELECT 0")
        requests.length = 0
        expect(
          yield* batch.execute([
            { sql: "SELECT ? UNION ALL SELECT ?", params: [41, 42] },
            { sql: "SELECT ?", params: ["second"] },
            { sql: "SELECT ?", params: [new Uint8Array([1, 2, 3])] },
          ]),
        ).toEqual([[[41], [42]], [["second"]], [[Buffer.from([1, 2, 3])]]])
        expect(requests).toHaveLength(1)
        expect(requests[0]).toEqual([
          ...(warm ? [] : ["PRAGMA foreign_keys = ON"]),
          "SELECT ? UNION ALL SELECT ?",
          "SELECT ?",
          "SELECT ?",
        ])
        requests.length = 0
        expect(yield* batch.execute([])).toEqual([])
        expect(requests).toHaveLength(0)
      }),
    )
  },
)

it.each([401, 404])(
  "recovers a rejected read batch after HTTP %s",
  async (status) => {
    failHttpStatus = status
    await run(
      Effect.gen(function* () {
        const batch = yield* SqlReadBatch
        expect(
          yield* batch.execute([{ sql: "SELECT 81", params: [] }]),
        ).toEqual([[[81]]])
        expect(requests).toHaveLength(2)
        expect(requests[1]).toEqual(["PRAGMA foreign_keys = ON", "SELECT 81"])
      }),
      status === 401
        ? {
            authToken: Redacted.make("old"),
            refreshAuthToken: Effect.succeed(Redacted.make("new")),
          }
        : undefined,
    )
  },
)

it.each([0, 1, 2])(
  "retains completed sibling results and identifies failed statement %s without replay",
  async (statementIndex) => {
    await run(
      Effect.gen(function* () {
        const batch = yield* SqlReadBatch
        const statements = [11, 22, 33].map((value, index) => ({
          sql:
            index === statementIndex
              ? "SELECT * FROM missing_batch_table"
              : "SELECT ?",
          params: index === statementIndex ? [] : [value],
        }))
        const error = yield* Effect.flip(batch.execute(statements))
        expect(error.message).toContain("missing_batch_table")
        const cause = error.reason.cause
        expect(cause).toBeInstanceOf(SqlReadBatchError)
        if (cause instanceof SqlReadBatchError) {
          expect(cause.statementIndex).toBe(statementIndex)
          expect(cause.results).toEqual(
            [11, 22, 33].map((value, index) =>
              index < statementIndex ? [[value]] : null,
            ),
          )
        }
        expect(requests).toHaveLength(1)
        expect(
          yield* batch.execute([{ sql: "SELECT 44", params: [] }]),
        ).toEqual([[[44]]])
        expect(requests[1]).toEqual(["SELECT 44"])
      }),
    )
  },
)

it("does not replay reads after an incomplete pipeline response", async () => {
  truncateBatchResponse = true
  await run(
    Effect.gen(function* () {
      const batch = yield* SqlReadBatch
      const error = yield* Effect.flip(
        batch.execute([
          { sql: "SELECT 1", params: [] },
          { sql: "SELECT 2", params: [] },
        ]),
      )
      expect(String(error.reason.cause)).toContain(
        "one result and one error per step",
      )
      expect(requests).toHaveLength(1)
      expect(yield* batch.execute([{ sql: "SELECT 3", params: [] }])).toEqual([
        [[3]],
      ])
    }),
  )
})

it.each(["interrupt", "timeout"])(
  "keeps the baton until an in-flight batch settles on %s and cancels queued reads",
  async (cancel) => {
    await run(
      Effect.gen(function* () {
        const batch = yield* SqlReadBatch
        const sql = yield* SqlClient.SqlClient
        const received = yield* Deferred.make<void>()
        const released = Promise.withResolvers<void>()
        heldResponse = {
          received: () => Effect.runSync(Deferred.succeed(received, undefined)),
          release: released.promise,
        }
        const operation = batch.execute([{ sql: "SELECT 71", params: [] }])
        const first = yield* (
          cancel === "timeout"
            ? operation.pipe(Effect.timeout("50 millis"))
            : operation
        ).pipe(Effect.forkChild)
        yield* Deferred.await(received)
        if (cancel === "interrupt") yield* Fiber.interrupt(first)
        else yield* Fiber.await(first)
        const queued = yield* batch
          .execute([{ sql: "SELECT 72", params: [] }])
          .pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* Fiber.interrupt(queued)
        const next = yield* sql
          .unsafe("SELECT 73")
          .values.pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* Effect.sleep("20 millis")
        expect(requests).toHaveLength(1)
        released.resolve()
        expect(yield* Fiber.join(next)).toEqual([[73]])
        expect(
          requests.flat().filter((sql) => sql === "SELECT 71"),
        ).toHaveLength(1)
        expect(requests.flat()).not.toContain("SELECT 72")
        expect(requests).toHaveLength(2)
      }),
    )
  },
)

it.each(["interrupt", "timeout"])(
  "finishes scoped batch %s before the response settles and closes the session afterwards",
  async (cancel) => {
    const received = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    const closed = Promise.withResolvers<void>()
    heldResponse = { received: received.resolve, release: released.promise }
    let closes = 0
    onSessionClosed = () => {
      closes += 1
      closed.resolve()
    }
    const controller = new AbortController()
    const scoped = Effect.gen(function* () {
      const batch = yield* SqlReadBatch
      yield* batch.execute([{ sql: "SELECT 75", params: [] }])
    }).pipe(Effect.provide(cloudLayer()))
    // The timeout must encompass layer cleanup, not just the SQL operation.
    const task = Effect.runPromise(
      cancel === "timeout" ? scoped.pipe(Effect.timeout("50 millis")) : scoped,
      { signal: controller.signal },
    ).then(
      () => "success",
      () => "cancelled",
    )
    try {
      await received.promise
      if (cancel === "interrupt") controller.abort()
      const outcome = await Promise.race([
        task,
        Bun.sleep(250).then(() => "still waiting for response"),
      ])
      expect(outcome).toBe("cancelled")
      expect(closes).toBe(0)
    } finally {
      released.resolve()
      await task
      await Promise.race([
        closed.promise,
        Bun.sleep(1000).then(() => {
          throw new Error("Session was not closed after the response settled")
        }),
      ])
    }
    expect(closes).toBe(1)
    expect(requests.flat().filter((sql) => sql === "SELECT 75")).toHaveLength(1)
  },
)

it("uses the transaction-bound connection for read batches", async () => {
  await run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const batch = yield* SqlReadBatch
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql.unsafe("INSERT INTO parent VALUES (701)")
          expect(
            yield* batch.execute([
              { sql: "SELECT id FROM parent WHERE id = ?", params: [701] },
              { sql: "SELECT 702", params: [] },
            ]),
          ).toEqual([[[701]], [[702]]])
        }),
      )
    }),
  )
  expect(
    requests.filter((s) => s[0] === "SELECT id FROM parent WHERE id = ?"),
  ).toHaveLength(1)
})

it("waits for an interrupted transaction's read batch before rolling back its session", async () => {
  await run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const batch = yield* SqlReadBatch
      const received = yield* Deferred.make<void>()
      const released = Promise.withResolvers<void>()
      const transaction = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql.unsafe("INSERT INTO parent VALUES (703)")
            heldResponse = {
              received: () =>
                Effect.runSync(Deferred.succeed(received, undefined)),
              release: released.promise,
            }
            yield* batch.execute([{ sql: "SELECT 704", params: [] }])
          }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(received)
      const interrupt = yield* Fiber.interrupt(transaction).pipe(
        Effect.forkChild,
      )
      yield* Effect.sleep("20 millis")
      expect(requests.flat()).not.toContain("ROLLBACK")
      released.resolve()
      yield* Fiber.join(interrupt)
      expect(requests.flat()).toContain("ROLLBACK")
      expect(
        yield* sql.unsafe("SELECT id FROM parent WHERE id = 703").values,
      ).toEqual([])
    }),
  )
})

it.each([false, true])(
  "failed PRAGMA prevents SQL/BEGIN and allows later initialization (transaction=%s)",
  async (transaction) => {
    failPragma = true
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const insert = sql.unsafe("INSERT INTO parent VALUES (101)")
        yield* Effect.flip(transaction ? sql.withTransaction(insert) : insert)
        expect(
          yield* sql.unsafe("SELECT id FROM parent WHERE id = 101").values,
        ).toEqual([])
        expect(yield* sql.unsafe("PRAGMA foreign_keys").values).toEqual([[1]])
      }),
    )
    expect(requests[1]?.[0]).toBe("PRAGMA foreign_keys = ON")
    const events = spans
      .flatMap((s) => s.events)
      .filter(([name]) => name === "turso.session.first_use")
    expect(
      events.some(
        (event) => event[2]?.["turso.initialization.success"] === false,
      ),
    ).toBe(true)
  },
)

it("preserves successful initialization after a failed application step without replaying writes", async () => {
  await run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* Effect.flip(sql.unsafe("INSERT INTO missing_table VALUES (1)"))
      const inserted = yield* sql.unsafe("INSERT INTO parent VALUES (?)", [102])
        .raw
      expect(inserted).toMatchObject({ rowsAffected: 1, lastInsertRowid: 102n })
      expect(
        yield* sql.unsafe("SELECT id FROM parent WHERE id = 102").values,
      ).toEqual([[102]])
    }),
  )
  expect(
    requests.flat().filter((s) => s === "PRAGMA foreign_keys = ON"),
  ).toHaveLength(1)
})

it("initializes a replacement session after token refresh", async () => {
  failHttpStatus = 401
  await run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      expect(yield* sql.unsafe("SELECT 7").values).toEqual([[7]])
      yield* sql.unsafe("SELECT 8")
    }),
    {
      authToken: Redacted.make("old"),
      refreshAuthToken: Effect.succeed(Redacted.make("new")),
    },
  )
  expect(requests.slice(0, 2)).toEqual(
    Array.from({ length: 2 }, () => ["PRAGMA foreign_keys = ON", "SELECT 7"]),
  )
  expect(requests).toHaveLength(3)
})

it.each([false, true])(
  "keeps first-use telemetry on the active span (SQL propagation=%s)",
  async (propagate) => {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe("SELECT 1")
        yield* sql.withTransaction(sql.unsafe("SELECT 2"))
        yield* sql.unsafe("SELECT 3")
      }).pipe(
        Effect.provideService(Statement.SpanPropagationEnabled, propagate),
      ),
    )
    const events = spans.flatMap((span) =>
      span.events
        .filter(([name]) => name === "turso.session.first_use")
        .map((event) => ({ span, event })),
    )
    expect(events).toHaveLength(2)
    expect(
      events.find(
        ({ event }) =>
          event[2]?.["turso.initialization.operation"] === "statement",
      )?.span.name,
    ).toBe(propagate ? "sqlite" : "caller")
    expect(
      events.find(
        ({ event }) => event[2]?.["turso.initialization.operation"] === "begin",
      )?.span.name,
    ).toBe("sql.transaction")
    for (const { event } of events)
      expect(event[2]?.["turso.initialization.duration_ms"]).toBeGreaterThan(0)
    expect(spans).toHaveLength(7) // caller, transaction, BEGIN, COMMIT, three queries
  },
)
