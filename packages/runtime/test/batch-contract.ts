import assert from "node:assert/strict"
import { QueueService } from "@processfocus/runtime"
import { Clock, DateTime, Duration, Effect, Option, Tracer } from "effect"
import { Statement } from "effect/sql"

/** Shared storage contract, exercised against each real queue adapter. */
export const batchQueueCases = [
  {
    name: "batch claims preserve single-claim ordering, limits, and attempts",
    run: Effect.gen(function* () {
      const queue = yield* QueueService
      const name = `ordering-${crypto.randomUUID()}`
      const ids = []
      for (let i = 0; i < 8; i++) {
        ids.push(
          yield* queue.enqueueWithDelay(name, { i }, Duration.seconds(i % 2)),
        )
      }
      yield* queue.enqueueWithDelay(name, { delayed: true }, Duration.days(1))
      const clock = yield* Clock.Clock
      let now = DateTime.toEpochMillis(yield* DateTime.now) + 2_000
      yield* Effect.gen(function* () {
        const prior = yield* queue.rawClaim(name, Duration.seconds(1))
        assert(Option.isSome(prior))
        yield* queue.fail(prior.value.jobId, prior.value.receipt, {
          releaseImmediately: true,
        })
        const expected = []
        for (let i = 0; i < ids.length; i++) {
          const job = yield* queue.rawClaim(name, Duration.seconds(1))
          assert(Option.isSome(job))
          expected.push(job.value)
        }
        assert(Option.isNone(yield* queue.rawClaim(name)))
        now += 1_001
        const batch = yield* queue.rawClaimBatch(name, 5, Duration.seconds(1))
        assert.deepEqual(
          batch.map((job) => job.jobId),
          expected.slice(0, 5).map((job) => job.jobId),
        )
        assert.deepEqual(
          batch.map((job) => job.attempts),
          expected.slice(0, 5).map((job) => job.attempts + 1),
        )
        assert.equal(
          new Set(batch.map((job) => job.receipt)).size,
          batch.length,
        )
        assert(
          batch.every(
            (job) => DateTime.toEpochMillis(job.lockedUntil) === now + 1_000,
          ),
        )
        const otherWorker = yield* queue.rawClaimBatch(name, 10)
        assert.deepEqual(
          otherWorker.map((job) => job.jobId),
          expected.slice(5).map((job) => job.jobId),
        )
      }).pipe(
        Effect.provideService(Clock.Clock, {
          currentTimeNanos: clock.currentTimeNanos,
          monotonicTimeNanos: clock.monotonicTimeNanos,
          currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
          monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
          sleep: (duration) => clock.sleep(duration),
          currentTimeMillis: Effect.sync(() => now),
          currentTimeMillisUnsafe: () => now,
        }),
      )
    }),
  },
  {
    name: "batch acknowledgments fence every pair and leave unsent jobs replayable",
    run: Effect.gen(function* () {
      const queue = yield* QueueService
      const name = `receipts-${crypto.randomUUID()}`
      for (let i = 0; i < 4; i++) yield* queue.enqueue(name, { i })
      const clock = yield* Clock.Clock
      let now = DateTime.toEpochMillis(yield* DateTime.now) + 1
      yield* Effect.gen(function* () {
        const jobs = yield* queue.rawClaimBatch(name, 3, Duration.seconds(1))
        const other = yield* queue.rawClaimBatch(name, 3, Duration.seconds(1))
        assert.equal(jobs.length, 3)
        assert.equal(other.length, 1)
        const [sent, unsent, alsoUnsent] = jobs
        assert(sent && unsent && alsoUnsent && other[0])
        // A foreign receipt for another row in the SAME batch must also be fenced.
        assert.deepEqual(
          yield* queue.acknowledgeBatch([
            { jobId: unsent.jobId, receipt: other[0].receipt },
            { jobId: other[0].jobId, receipt: unsent.receipt },
            { jobId: "missing", receipt: sent.receipt },
            sent,
          ]),
          [sent.jobId],
        )
        // Interruption after a send, before ack: only the acknowledged row is gone.
        now += 1_001
        const replayed = yield* queue.rawClaimBatch(name, 10)
        assert.equal(replayed.length, 3)
        assert(replayed.every((job) => job.attempts === 2))
        assert.deepEqual(yield* queue.acknowledgeBatch([...jobs, ...other]), [])
        assert.equal((yield* queue.acknowledgeBatch(replayed)).length, 3)
        assert.deepEqual(yield* queue.rawClaimBatch(name, 10), [])
      }).pipe(
        Effect.provideService(Clock.Clock, {
          currentTimeNanos: clock.currentTimeNanos,
          monotonicTimeNanos: clock.monotonicTimeNanos,
          currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
          monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
          sleep: (duration) => clock.sleep(duration),
          currentTimeMillis: Effect.sync(() => now),
          currentTimeMillisUnsafe: () => now,
        }),
      )
    }),
  },
  {
    name: "16-item batches use constant writes and empty batches open no write transaction",
    run: Effect.gen(function* () {
      const queue = yield* QueueService
      const name = `commits-${crypto.randomUUID()}`
      for (let i = 0; i < 16; i++) yield* queue.enqueue(name, { i })
      const statements: string[] = []
      const spans: string[] = []
      const observe = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(Statement.CurrentTransformer, (statement) =>
            Effect.sync(() => {
              statements.push(statement.compile()[0])
              return statement
            }),
          ),
          Effect.withTracer(
            Tracer.make({
              span(options) {
                spans.push(options.name)
                return new Tracer.NativeSpan(options)
              },
            }),
          ),
        )
      yield* observe(
        Effect.gen(function* () {
          const jobs = yield* queue.rawClaimBatch(name, 100)
          assert.equal(jobs.length, 16)
          assert.equal((yield* queue.acknowledgeBatch(jobs)).length, 16)
        }),
      )
      // One batched claim update, plus at most one zero-row writer reservation
      // before acknowledgement samples lease time. Neither scales with jobs.
      const updates = statements.filter((s) => /\bupdate\b/i.test(s)).length
      assert(updates >= 1 && updates <= 2)
      assert.equal(statements.filter((s) => /^delete/i.test(s)).length, 1)
      // Acknowledgement may explicitly transact to guard lease time; previously
      // its single DELETE used an implicit transaction (the same durable write).
      assert(spans.filter((name) => name === "sql.transaction").length <= 2)
      statements.length = 0
      spans.length = 0
      yield* observe(
        Effect.gen(function* () {
          assert.deepEqual(yield* queue.rawClaimBatch(name, 100), [])
          assert.deepEqual(yield* queue.acknowledgeBatch([]), [])
        }),
      )
      assert.equal(
        statements.filter((s) => /\b(update|delete|insert)\b/i.test(s)).length,
        0,
      )
      assert(!spans.includes("sql.transaction"))
      assert(yield* queue.rawClaimBatch(name, 0).pipe(Effect.isFailure))
      assert(yield* queue.rawClaimBatch(name, 1.5).pipe(Effect.isFailure))
    }),
  },
]
