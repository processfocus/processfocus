import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Queue, QueueService } from "@processfocus/runtime"
import { eq } from "drizzle-orm"
import {
  Cause,
  ConfigProvider,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Result,
  Schema,
  Semaphore,
} from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import * as schema from "@pf/drizzle-sqlite"
import { UserDetails } from "@pf/graphql-db-operations"
import { makeTursoLive } from "@pf/layer-turso-local"
import { RequestTime } from "@pf/request-time"
import {
  TypedSqliteDrizzle,
  TypedSqliteDrizzleLayer,
} from "@pf/service-drizzle-sqlite"
import {
  type SqliteQueueMaintenance,
  SqliteQueueServiceLive,
} from "@pf/sqlite-queue-service"
import {
  AttemptEscalation,
  type AttemptPolicy,
  readAttemptPolicy,
  runLocalAttempt,
} from "./attempt-lifecycle"
import {
  type LocalQueueWorkerState,
  createSingleQueuePoller,
} from "./queue-poller"
import { jobHandler } from "./types"
import { describe, expect, it } from "bun:test"

const policy: AttemptPolicy = {
  executionMs: 7_000,
  cancellationGraceMs: 200,
  // Leave room for native transaction acquisition/commit between logical ticks.
  queueIoMs: 1000,
  visibilityMs: 3_000,
}

// Real file-backed local engine and typed adapter, not a queue that supplies its
// own claim/receipt ordering. Only the queue's table is needed for this boundary.
const runTest = async <E>(
  test: Effect.Effect<
    void,
    E,
    | QueueService
    | SqliteQueueMaintenance
    | TypedSqliteDrizzle
    | SqlClient.SqlClient
  >,
) => {
  const directory = await mkdtemp(join(tmpdir(), "attempt-lifecycle-"))
  const SqlLive = makeTursoLive().pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          SQLITE_DATABASE_PATH: `${directory}/pf.db`,
        }),
      ),
    ),
  )
  const Database = Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TABLE pf_job_queue (
      id TEXT PRIMARY KEY NOT NULL, queue TEXT NOT NULL, job_payload TEXT NOT NULL,
      job_attempts INTEGER NOT NULL DEFAULT 0, job_retry_limit INTEGER NOT NULL DEFAULT 5,
       available_at REAL NOT NULL, locked_until REAL, claim_receipt TEXT,
       terminal_at REAL, terminal_reason TEXT, terminal_outcome TEXT, redriven_from TEXT,
      created_at REAL NOT NULL, updated_at REAL NOT NULL, created_by TEXT NOT NULL,
      updated_by TEXT NOT NULL, _deleted INTEGER NOT NULL DEFAULT 0
    )`
    }),
  ).pipe(
    Layer.provideMerge(
      TypedSqliteDrizzleLayer.pipe(Layer.provideMerge(SqlLive)),
    ),
  )
  const TestLayer = SqliteQueueServiceLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Database,
        Layer.succeed(RequestTime, DateTime.makeUnsafe(0)),
        Layer.succeed(UserDetails, { by: "TEST", id: "test" }),
      ),
    ),
  )
  try {
    await Effect.runPromise(
      Effect.scoped(test).pipe(
        Effect.provide(TestLayer),
        Effect.provide(TestClock.layer()),
      ),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const advance = Effect.fnUntraced(function* (milliseconds: number) {
  yield* TestClock.adjust(milliseconds)
  // TestClock settles Effect fibers, not native Turso I/O. Give the root
  // connection a roundtrip; this does not drain separate transaction connections.
  const sql = yield* SqlClient.SqlClient
  yield* sql`SELECT 1`
})

const advanceUntil = Effect.fnUntraced(function* <A>(
  signal: Deferred.Deferred<A>,
  steps = 200,
  tick = advance,
) {
  for (let step = 0; step < steps; step++) {
    if (yield* Deferred.isDone(signal)) return yield* Deferred.await(signal)
    yield* tick(100)
  }
  return yield* Effect.fail(
    new Error("Lifecycle signal not reached within 20 seconds"),
  )
})

// Native transaction connections are not drained by SELECT on the root
// connection. Let real adapter calls finish before moving logical time;
// otherwise CI load can turn healthy I/O into a synthetic watchdog timeout.
// Opt in only for tests that do not intentionally block queue I/O.
const settleQueueBeforeAdvance = (queue: Queue) => {
  const pending = new Set<Promise<void>>()
  const observe = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      const settled = Promise.withResolvers<void>()
      pending.add(settled.promise)
      return operation.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pending.delete(settled.promise)
            settled.resolve()
          }),
        ),
      )
    })
  const observedQueue = {
    ...queue,
    rawClaim: (...args: Parameters<typeof queue.rawClaim>) =>
      observe(queue.rawClaim(...args)),
    extendVisibility: (...args: Parameters<typeof queue.extendVisibility>) =>
      observe(queue.extendVisibility(...args)),
    acknowledge: (...args: Parameters<typeof queue.acknowledge>) =>
      observe(queue.acknowledge(...args)),
    fail: (...args: Parameters<typeof queue.fail>) =>
      observe(queue.fail(...args)),
  }
  const settle = Effect.gen(function* () {
    do {
      yield* Effect.promise(() => Promise.all([...pending]))
      yield* Effect.yieldNow
    } while (pending.size > 0)
  })
  const tick = (milliseconds: number) =>
    settle.pipe(Effect.andThen(advance(milliseconds)), Effect.andThen(settle))
  return { observedQueue, tick }
}

it("recovers at startup and periodically while arrivals continue and an interruptible handler holds the only permit", () =>
  runTest(
    Effect.gen(function* () {
      const queue = yield* QueueService
      const db = yield* TypedSqliteDrizzle
      const semaphore = yield* Semaphore.make(1)
      // Already exhausted legacy work must be disposed before dispatch at startup.
      const startup = yield* queue.enqueue(
        "startup-recovery",
        {},
        { retryLimit: 0 },
      )
      const sql = yield* SqlClient.SqlClient
      yield* sql`UPDATE pf_job_queue SET job_attempts = 1 WHERE id = ${startup}`
      const abandoned = yield* queue.enqueue(
        "abandoned-final",
        {},
        { retryLimit: 0 },
      )
      yield* queue.rawClaim("abandoned-final", Duration.millis(1500))
      const occupied = yield* queue.enqueue("occupied", {}, { retryLimit: 0 })
      const started = yield* Deferred.make<void>()
      const poller = yield* Effect.forkChild(
        createSingleQueuePoller(
          {
            occupied: jobHandler({
              schema: Schema.Struct({}),
              handle: () =>
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                ),
            }),
            arrivals: jobHandler({
              schema: Schema.Struct({}),
              handle: () => Effect.void,
            }),
          },
          semaphore,
          { attemptPolicy: policy },
        ),
      )
      yield* advanceUntil(started)
      expect(
        (yield* db
          .select()
          .from(schema.jobQueue)
          .where(eq(schema.jobQueue.id, startup)))[0]?.terminalOutcome,
      ).toBe("unknown")
      let recovered = false
      for (let tick = 0; tick < 40; tick++) {
        yield* queue
          .enqueue("arrivals", {})
          .pipe(Effect.provideService(RequestTime, yield* DateTime.now))
        yield* advance(100)
        const [row] = yield* db
          .select()
          .from(schema.jobQueue)
          .where(eq(schema.jobQueue.id, abandoned))
        if (row?.terminalAt !== null) {
          recovered = true
          break
        }
      }
      expect(recovered).toBe(true)
      // Maintenance did not need the occupied permit, invoke the abandoned handler,
      // or promote old work above the continuously arriving fresh work.
      expect(
        Option.isNone(yield* semaphore.withPermitsIfAvailable(1)(Effect.void)),
      ).toBe(true)
      const [live] = yield* db
        .select()
        .from(schema.jobQueue)
        .where(eq(schema.jobQueue.id, occupied))
      expect(live?.terminalAt).toBeNull()
      expect(live?.jobAttempts).toBe(1)
      expect((yield* queue.getStats("arrivals")).pending).toBeGreaterThan(0)
      yield* Fiber.interrupt(poller)
    }),
  ))

describe("local cooperative lifecycle on file-backed Turso", () => {
  it.each(["cooperative", "blocked"] as const)(
    "retains the permit during %s cleanup on controller interruption",
    async (cleanup) => {
      await runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          yield* queue.enqueue("work", { value: "interrupt" })
          const job = yield* queue.rawClaim(
            "work",
            Duration.millis(policy.visibilityMs),
          )
          expect(Option.isSome(job)).toBe(true)
          if (Option.isNone(job)) return
          const started = yield* Deferred.make<void>()
          const unblock = yield* Deferred.make<void>()
          const released = yield* Deferred.make<void>()
          let cleaned = false
          let error: AttemptEscalation | undefined
          const controller = yield* Effect.forkChild(
            runLocalAttempt(
              job.value,
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(
                  (cleanup === "cooperative"
                    ? Effect.sleep(100)
                    : Deferred.await(unblock)
                  ).pipe(
                    Effect.andThen(
                      Effect.sync(() => {
                        cleaned = true
                      }),
                    ),
                  ),
                ),
              ),
              policy,
              (escalation) => {
                error = escalation
              },
            ).pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() => {
                  const failure = Cause.findErrorOption(cause)
                  if (
                    Option.isSome(failure) &&
                    failure.value instanceof AttemptEscalation
                  )
                    error = failure.value
                }),
              ),
              Effect.ensuring(Deferred.succeed(released, undefined)),
            ),
          )
          yield* advanceUntil(started)
          const interruptedAt = DateTime.toEpochMillis(yield* DateTime.now)
          const interruption = yield* Effect.forkChild(
            Fiber.interrupt(controller),
          )
          yield* advance(50)
          expect(yield* Deferred.isDone(released)).toBe(false)
          yield* advanceUntil(released)
          yield* Fiber.join(interruption)
          const elapsed =
            DateTime.toEpochMillis(yield* DateTime.now) - interruptedAt
          if (cleanup === "cooperative") {
            expect(cleaned).toBe(true)
            expect(error).toBeUndefined()
          } else {
            expect(cleaned).toBe(false)
            expect(error?.phase).toBe("interruption-cleanup")
            expect(error?.jobId).toBe(job.value.jobId)
            yield* Deferred.succeed(unblock, undefined)
          }
          expect(elapsed).toBeLessThanOrEqual(policy.cancellationGraceMs + 100)
        }),
      )
    },
  )

  it("renews a live hang, cancels at the immutable deadline, drains other work and exhausts a finite budget", async () => {
    await runTest(
      Effect.gen(function* () {
        const queue = yield* QueueService
        const db = yield* TypedSqliteDrizzle
        const { observedQueue, tick } = settleQueueBeforeAdvance(queue)
        const started = yield* Deferred.make<void>()
        const completed = yield* Deferred.make<void>()
        const stopped = yield* Deferred.make<void>()
        let runs = 0
        let stoppedAt = 0
        const second = yield* queue.enqueue("work", { kind: "success" })
        const hung = yield* queue.enqueue(
          "work",
          { kind: "hang" },
          { retryLimit: 1 },
        )
        // Choose hang first using the real dispatch order, independent of ID format.
        yield* db
          .update(schema.jobQueue)
          .set({ availableAt: DateTime.makeUnsafe(-1) })
          .where(eq(schema.jobQueue.id, second))
        const poller = yield* Effect.forkChild(
          createSingleQueuePoller(
            {
              work: jobHandler({
                schema: Schema.Struct({ kind: Schema.String }),
                handle: (job) =>
                  job.payload.kind === "hang"
                    ? Effect.gen(function* () {
                        runs++
                        yield* Deferred.succeed(started, undefined)
                        yield* Effect.never
                      }).pipe(
                        Effect.ensuring(
                          Effect.gen(function* () {
                            stoppedAt = DateTime.toEpochMillis(
                              yield* DateTime.now,
                            )
                            yield* Deferred.succeed(stopped, undefined)
                          }),
                        ),
                      )
                    : Deferred.succeed(completed, undefined).pipe(
                        Effect.asVoid,
                      ),
              }),
            },
            yield* Semaphore.make(1),
            { attemptPolicy: policy },
          ).pipe(Effect.provideService(QueueService, observedQueue)),
        )
        yield* advanceUntil(started, 200, tick)
        const start = DateTime.toEpochMillis(yield* DateTime.now)
        for (let step = 0; step < 40; step++) yield* tick(100)
        const rows = yield* db
          .select()
          .from(schema.jobQueue)
          .where(eq(schema.jobQueue.id, hung))
        expect(DateTime.toEpochMillis(rows[0]!.lockedUntil!)).toBeGreaterThan(
          start + 4_000,
        )
        expect(yield* Deferred.isDone(stopped)).toBe(false)
        yield* advanceUntil(completed, 200, tick)
        expect(stoppedAt - start).toBeLessThanOrEqual(
          policy.executionMs + policy.cancellationGraceMs,
        )
        // Drain the remaining attempt, then observe retirement via the adapter.
        for (let step = 0; step < 120; step++) yield* tick(100)
        yield* Fiber.interrupt(poller)
        const remaining = yield* db.select().from(schema.jobQueue)
        expect(remaining).toHaveLength(1)
        expect(remaining[0]!.id).toBe(hung)
        expect(remaining[0]!.jobAttempts).toBe(2)
        expect(remaining[0]!.lockedUntil).toBeNull()
        expect(remaining[0]!.claimReceipt).toBeNull()
        expect(remaining[0]!.terminalAt).not.toBeNull()
        expect(remaining[0]!.terminalOutcome).toBe("unknown")
        expect(runs).toBe(2)
        expect(Option.isNone(yield* queue.rawClaim("work"))).toBe(true)
      }),
    )
  })

  it("cancels on receipt loss and fences late acknowledge, renew and fail against the newer owner", async () => {
    await runTest(
      Effect.gen(function* () {
        const queue = yield* QueueService
        const db = yield* TypedSqliteDrizzle
        const started = yield* Deferred.make<void>()
        const stopped = yield* Deferred.make<void>()
        const id = yield* queue.enqueue("work", { kind: "hang" })
        const poller = yield* Effect.forkChild(
          createSingleQueuePoller(
            {
              work: jobHandler({
                schema: Schema.Struct({ kind: Schema.String }),
                handle: () =>
                  Deferred.succeed(started, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.ensuring(Deferred.succeed(stopped, undefined)),
                  ),
              }),
            },
            yield* Semaphore.make(1),
            { attemptPolicy: policy },
          ),
        )
        yield* advanceUntil(started)
        const old = (yield* db
          .select()
          .from(schema.jobQueue)
          .where(eq(schema.jobQueue.id, id)))[0]!
        // Another owner wins after explicit lease loss (no fake receipt injection).
        yield* db
          .update(schema.jobQueue)
          .set({ lockedUntil: DateTime.makeUnsafe(0) })
          .where(eq(schema.jobQueue.id, id))
        // Expiry itself fences the receipt, even before anyone claims again.
        for (const operation of [
          queue.acknowledge(id, old.claimReceipt!),
          queue.extendVisibility(id, old.claimReceipt!, Duration.seconds(30)),
          queue.fail(id, old.claimReceipt!, { releaseImmediately: true }),
        ])
          expect(Result.isFailure(yield* Effect.result(operation))).toBe(true)
        const newer = yield* queue.rawClaim("work", Duration.seconds(30))
        expect(Option.isSome(newer)).toBe(true)
        if (Option.isNone(newer)) return
        yield* advanceUntil(stopped)
        yield* Fiber.interrupt(poller)
        for (const operation of [
          queue.acknowledge(id, old.claimReceipt!),
          queue.extendVisibility(id, old.claimReceipt!, Duration.seconds(30)),
          queue.fail(id, old.claimReceipt!, { releaseImmediately: true }),
          queue.fail(id, old.claimReceipt!, { retryable: false }),
        ]) {
          expect(Result.isFailure(yield* Effect.result(operation))).toBe(true)
        }
        const current = (yield* db
          .select()
          .from(schema.jobQueue)
          .where(eq(schema.jobQueue.id, id)))[0]!
        expect(current.claimReceipt).toBe(newer.value.receipt)
        expect(current.jobAttempts).toBe(2)
        yield* queue.acknowledge(id, newer.value.receipt)
      }),
    )
  })

  it("retries an ordinary handler failure without resetting its attempt budget", async () => {
    await runTest(
      Effect.gen(function* () {
        const queue = yield* QueueService
        const db = yield* TypedSqliteDrizzle
        const { observedQueue, tick } = settleQueueBeforeAdvance(queue)
        const completed = yield* Deferred.make<void>()
        const firstAttemptReleased = yield* Deferred.make<void>()
        const idle = yield* Deferred.make<void>()
        const attempts: number[] = []
        let pauseBetweenAttempts = false
        yield* queue.enqueue("work", { value: "retry" }, { retryLimit: 1 })
        const poller = yield* Effect.forkChild(
          createSingleQueuePoller(
            {
              work: jobHandler({
                schema: Schema.Struct({ value: Schema.String }),
                handle: (job) =>
                  Effect.gen(function* () {
                    attempts.push(job.attempts)
                    if (job.attempts === 1) {
                      pauseBetweenAttempts = true
                      return yield* Effect.fail(new Error("retryable failure"))
                    }
                    yield* Deferred.succeed(completed, undefined)
                  }),
              }),
            },
            yield* Semaphore.make(1),
            {
              attemptPolicy: policy,
              readPauseToken: () =>
                pauseBetweenAttempts ? "between-attempts" : null,
              onWorkerStateChange: (state) =>
                state.activeJobs === 0 && attempts.length > 0
                  ? Deferred.succeed(
                      attempts.length === 1 ? firstAttemptReleased : idle,
                      undefined,
                    ).pipe(Effect.asVoid)
                  : Effect.void,
            },
          ).pipe(Effect.provideService(QueueService, observedQueue)),
        )
        // Native Turso transactions do not advance with TestClock. Wait for
        // failure I/O to finish at a fixed time, then expire its lease while
        // paused. Do not race native failure/ack I/O against synthetic deadlines.
        yield* Deferred.await(firstAttemptReleased)
        yield* tick(policy.visibilityMs)
        pauseBetweenAttempts = false
        yield* tick(250)
        yield* Deferred.await(completed)
        yield* Deferred.await(idle)
        yield* Fiber.interrupt(poller)
        expect(attempts).toEqual([1, 2])
        expect(yield* db.select().from(schema.jobQueue)).toEqual([])
      }),
    )
  })

  it("bounds acknowledgement I/O and reports an actionable unknown-outcome escalation", async () => {
    await runTest(
      Effect.gen(function* () {
        const queue = yield* QueueService
        const db = yield* TypedSqliteDrizzle
        const escalated = yield* Deferred.make<LocalQueueWorkerState>()
        const id = yield* queue.enqueue("work", { value: "ack" })
        // Delay the real acknowledgement at its I/O boundary; persistence and
        // claims still come from Turso. Interruption must prevent the late delete.
        const delayed = QueueService.of({
          ...queue,
          acknowledge: (jobId, receipt) =>
            Effect.never.pipe(
              Effect.andThen(queue.acknowledge(jobId, receipt)),
            ),
        })
        const poller = yield* Effect.forkChild(
          createSingleQueuePoller(
            {
              work: jobHandler({
                schema: Schema.Struct({ value: Schema.String }),
                handle: () => Effect.void,
              }),
            },
            yield* Semaphore.make(1),
            {
              attemptPolicy: policy,
              onWorkerStateChange: (state) =>
                state.escalation
                  ? Deferred.succeed(escalated, state).pipe(Effect.asVoid)
                  : Effect.void,
            },
          ).pipe(Effect.provideService(QueueService, delayed)),
        )
        const state = yield* advanceUntil(escalated)
        expect(state.escalation?.phase).toBe("acknowledge-timeout")
        expect(DateTime.toEpochMillis(yield* DateTime.now)).toBeLessThan(
          policy.executionMs,
        )
        yield* Fiber.interrupt(poller)
        const row = (yield* db
          .select()
          .from(schema.jobQueue)
          .where(eq(schema.jobQueue.id, id)))[0]!
        expect(row.jobAttempts).toBe(1)
        expect(row.claimReceipt).toBe(state.escalation!.receipt)
      }),
    )
  })

  it.each(["deadline", "interruption"] as const)(
    "escalates a blocked finalizer after %s and stops admitting work until supervision",
    async (trigger) => {
      await runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          // Native renewal latency is wall-clock time, not TestClock time.
          // Exercise a healthy slow renewal so this test cannot accidentally
          // take the ownership-loss path instead of testing blocked cleanup.
          const slowRenewals = QueueService.of({
            ...queue,
            extendVisibility: (...args) =>
              Effect.promise(() => Bun.sleep(20)).pipe(
                Effect.andThen(queue.extendVisibility(...args)),
              ),
          })
          const { observedQueue, tick } = settleQueueBeforeAdvance(slowRenewals)
          const db = yield* TypedSqliteDrizzle
          const started = yield* Deferred.make<void>()
          const unblock = yield* Deferred.make<void>()
          const escalated = yield* Deferred.make<LocalQueueWorkerState>()
          const id = yield* queue.enqueue("work", { kind: "hang" })
          const poller = yield* Effect.forkChild(
            createSingleQueuePoller(
              {
                work: jobHandler({
                  schema: Schema.Struct({ kind: Schema.String }),
                  handle: () =>
                    Deferred.succeed(started, undefined).pipe(
                      Effect.andThen(Effect.never),
                      Effect.ensuring(Deferred.await(unblock)),
                    ),
                }),
              },
              yield* Semaphore.make(1),
              {
                attemptPolicy: policy,
                onWorkerStateChange: (state) =>
                  state.escalation
                    ? Deferred.succeed(escalated, state).pipe(Effect.asVoid)
                    : Effect.void,
              },
            ).pipe(Effect.provideService(QueueService, observedQueue)),
          )
          yield* advanceUntil(started, 200, tick)
          const other = yield* queue.enqueue("work", { kind: "success" })
          if (trigger === "interruption")
            yield* Effect.sync(() => poller.interruptUnsafe())
          const state = yield* advanceUntil(escalated, 200, tick)
          expect(state.escalation?.jobId).toBe(id)
          expect(state.escalation?.phase).toBe(
            trigger === "deadline" ? "cancellation" : "interruption-cleanup",
          )
          expect(state.escalation?.outcome).toBe("unknown")
          yield* tick(1_000)
          const row = (yield* db
            .select()
            .from(schema.jobQueue)
            .where(eq(schema.jobQueue.id, other)))[0]!
          expect(row.jobAttempts).toBe(0)
          yield* Deferred.succeed(unblock, undefined)
          yield* Fiber.interrupt(poller)
        }),
      )
    },
  )
})

it("rejects invalid lifecycle bounds before claiming", async () => {
  for (const value of [0, -1, NaN, Infinity, 0.5, 2_147_483_648]) {
    for (const field of [
      "executionMs",
      "cancellationGraceMs",
      "queueIoMs",
      "visibilityMs",
    ]) {
      expect(
        Result.isFailure(
          await Effect.runPromise(
            readAttemptPolicy({ ...policy, [field]: value }).pipe(
              Effect.result,
            ),
          ),
        ),
      ).toBe(true)
    }
  }
  expect(
    Result.isFailure(
      await Effect.runPromise(
        readAttemptPolicy({ ...policy, queueIoMs: policy.visibilityMs }).pipe(
          Effect.result,
        ),
      ),
    ),
  ).toBe(true)
})
