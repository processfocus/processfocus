import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { QueueService, QueueStatsError } from "@processfocus/runtime"
import { DateTime, Effect, Exit, Fiber, Logger, Option, Result } from "effect"
import { SqlClient } from "effect/sql"
import * as schema from "@pf/drizzle-sqlite"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"
import { SqliteQueueMaintenance } from "@pf/sqlite-queue-service"
import {
  createSupervisedQueueTable,
  supervisedQueueLayer,
} from "../test-support/supervised-queue"
import {
  type QueueObservation,
  observeQueueHealth,
  readQueueObservationPolicy,
} from "./queue-health"
import { claimNextLocalJob } from "./queue-poller"
import { expect, it } from "bun:test"

const withQueue = async <E>(
  test: Effect.Effect<
    void,
    E,
    | QueueService
    | SqliteQueueMaintenance
    | TypedSqliteDrizzle
    | SqlClient.SqlClient
  >,
) => {
  const directory = await mkdtemp("/tmp/opencode/queue-health-")
  try {
    await Effect.runPromise(
      createSupervisedQueueTable.pipe(
        Effect.andThen(test),
        Effect.provide(supervisedQueueLayer(join(directory, "pf.db"))),
      ),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

// Storage classification is owned here, including the final-live versus
// exhausted-expired distinction and the current lease's excluded waiting time.
it("reports disjoint lifecycle counts and eligible age from the real queue snapshot", () =>
  withQueue(
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const maintenance = yield* SqliteQueueMaintenance
      const now = DateTime.toEpochMillis(yield* DateTime.now)
      yield* db.insert(schema.jobQueue).values([
        {
          id: "old",
          queue: "work",
          jobPayload: {},
          availableAt: DateTime.makeUnsafe(now - 5000),
        },
        {
          id: "delayed",
          queue: "work",
          jobPayload: {},
          availableAt: DateTime.makeUnsafe(now + 60000),
        },
        {
          id: "live-final",
          queue: "work",
          jobPayload: {},
          availableAt: DateTime.makeUnsafe(0),
          jobAttempts: 1,
          jobRetryLimit: 1,
          lockedUntil: DateTime.makeUnsafe(now + 60000),
        },
        {
          id: "recovery",
          queue: "work",
          jobPayload: {},
          availableAt: DateTime.makeUnsafe(0),
          jobAttempts: 1,
          jobRetryLimit: 1,
          lockedUntil: DateTime.makeUnsafe(now - 1000),
        },
        {
          id: "terminal",
          queue: "work",
          jobPayload: {},
          availableAt: DateTime.makeUnsafe(0),
          terminalAt: DateTime.makeUnsafe(now),
        },
        {
          id: "expired-retry",
          queue: "retry",
          jobPayload: {},
          availableAt: DateTime.makeUnsafe(0),
          jobAttempts: 1,
          lockedUntil: DateTime.makeUnsafe(now - 1000),
        },
      ])
      const before = yield* maintenance.inspect()
      const health = before.find((entry) => entry.queue === "work")!
      expect(health).toMatchObject({
        eligible: 1,
        delayed: 1,
        processing: 1,
        recoveryNeeded: 1,
        terminal: 1,
        oldestEligible: { jobId: "old" },
      })
      expect(health.oldestEligible!.waitingMs).toBeGreaterThanOrEqual(5000)
      const retry = before.find((entry) => entry.queue === "retry")!
      expect(retry.oldestEligible!.waitingMs).toBeGreaterThanOrEqual(1000)
      expect(retry.oldestEligible!.waitingMs).toBeLessThan(2000)
      yield* maintenance.recover()
      expect(
        (yield* maintenance.inspect()).find((entry) => entry.queue === "work"),
      ).toMatchObject({ processing: 1, recoveryNeeded: 0, terminal: 2 })
      const queue = yield* QueueService
      const releasedId = yield* queue.enqueue("released", {})
      const released = Option.getOrThrow(yield* queue.rawClaim("released"))
      yield* queue.fail(releasedId, released.receipt, {
        releaseImmediately: true,
      })
      const releasedHealth = (yield* maintenance.inspect()).find(
        (entry) => entry.queue === "released",
      )!
      expect(releasedHealth.eligible).toBe(1)
      expect(releasedHealth.oldestEligible?.jobId).toBe(releasedId)
      expect(releasedHealth.oldestEligible!.waitingMs).toBeLessThan(1000)
    }),
  ))

it("keeps old eligible work visible while newer jobs finish, then drains finite work", () =>
  withQueue(
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const queue = yield* QueueService
      const maintenance = yield* SqliteQueueMaintenance
      yield* db.insert(schema.jobQueue).values({
        id: "old",
        queue: "work",
        jobPayload: {},
        availableAt: DateTime.makeUnsafe(1),
      })
      for (let n = 0; n < 20; n++) {
        yield* db.insert(schema.jobQueue).values({
          id: `fresh-${n}`,
          queue: "work",
          jobPayload: {},
          availableAt: DateTime.makeUnsafe(n + 2),
        })
        const claim = yield* claimNextLocalJob(["work"])
        expect(claim).toMatchObject({ value: { jobId: `fresh-${n}` } })
        if (Option.isSome(claim))
          yield* queue.acknowledge(claim.value.jobId, claim.value.receipt)
        expect((yield* maintenance.inspect())[0]?.oldestEligible?.jobId).toBe(
          "old",
        )
      }
      const final = yield* claimNextLocalJob(["work"])
      expect(final).toMatchObject({ value: { jobId: "old" } })
      if (Option.isSome(final))
        yield* queue.acknowledge(final.value.jobId, final.value.receipt)
      expect(yield* maintenance.inspect()).toEqual([])
    }),
  ))

it("preserves read errors through getStats and observation, rate-limits warnings without dropping work", () =>
  withQueue(
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const sql = yield* SqlClient.SqlClient
      const queue = yield* QueueService
      yield* db.insert(schema.jobQueue).values({
        id: "waiting",
        queue: "work",
        jobPayload: {},
        availableAt: DateTime.makeUnsafe(1),
      })
      const observations: QueueObservation[] = []
      const warnings: { at: number; message: ReadonlyArray<unknown> }[] = []
      const logger = Logger.make(({ message }) => {
        if (
          Array.isArray(message) &&
          message[0] === "Local queue eligible work waiting"
        )
          // Throttling uses the sample timestamp, before asynchronous DB I/O.
          // Log delivery times can be closer together when one read is slower.
          warnings.push({
            at: Date.parse(observations.at(-1)!.sampledAt),
            message,
          })
      })
      const fiber = yield* observeQueueHealth(
        (value) => observations.push(value),
        {
          PF_LOCAL_QUEUE_SAMPLE_MS: "20",
          PF_LOCAL_QUEUE_WAIT_WARNING_MS: "1",
          PF_LOCAL_QUEUE_WARNING_INTERVAL_MS: "150",
        },
      ).pipe(Effect.provide(Logger.layer([logger])), Effect.forkChild)
      yield* Effect.sleep(380)
      expect(observations.length).toBeGreaterThan(3)
      expect(warnings.length).toBeGreaterThanOrEqual(2)
      expect(warnings.length).toBeLessThanOrEqual(3)
      expect(warnings[0]?.message[1]).toMatchObject({
        queue: "work",
        jobId: "waiting",
      })
      for (let i = 1; i < warnings.length; i++)
        expect(warnings[i]!.at - warnings[i - 1]!.at).toBeGreaterThanOrEqual(
          150,
        )
      expect((yield* db.select().from(schema.jobQueue))[0]?.jobAttempts).toBe(0)
      yield* sql`DROP TABLE pf_job_queue`
      const result = yield* queue.getStats("work").pipe(Effect.result)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(QueueStatsError)
        expect(result.failure.cause).toBeDefined()
      }
      yield* Effect.sleep(60)
      expect(observations.at(-1)).toMatchObject({
        status: "unavailable",
        error: expect.stringContaining("QueueStatsError"),
      })
      yield* Fiber.interrupt(fiber)
    }),
  ))

it("keeps observing pending recovery after maintenance failure and retries independently", () =>
  withQueue(
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const sql = yield* SqlClient.SqlClient
      yield* db.insert(schema.jobQueue).values({
        id: "exhausted",
        queue: "work",
        jobPayload: {},
        availableAt: DateTime.makeUnsafe(0),
        jobAttempts: 1,
        jobRetryLimit: 1,
      })
      yield* sql`CREATE TRIGGER reject_recovery BEFORE UPDATE ON pf_job_queue BEGIN SELECT RAISE(ABORT, 'maintenance unavailable'); END`
      const observations: QueueObservation[] = []
      const errors: ReadonlyArray<unknown>[] = []
      const logger = Logger.make(({ message }) => {
        if (Array.isArray(message)) errors.push(message)
      })
      const fiber = yield* observeQueueHealth(
        (value) => observations.push(value),
        { PF_LOCAL_QUEUE_SAMPLE_MS: "20" },
      ).pipe(Effect.provide(Logger.layer([logger])), Effect.forkChild)
      yield* Effect.sleep(150)
      expect(
        errors.some(
          (message) => message[0] === "Queue terminal recovery failed",
        ),
      ).toBe(true)
      expect(observations.at(-1)).toMatchObject({
        status: "available",
        queues: [{ recoveryNeeded: 1, terminal: 0 }],
      })
      yield* sql`DROP TRIGGER reject_recovery`
      // Recovery sleeps between attempts, and observation publishes independently.
      // Wait for the published transition rather than assuming both have run
      // within 100ms of the next maintenance tick on a loaded runner.
      yield* Effect.gen(function* () {
        while (true) {
          const latest = observations.at(-1)
          if (
            latest?.status === "available" &&
            latest.queues[0]?.terminal === 1
          )
            return
          yield* Effect.sleep(20)
        }
      }).pipe(Effect.timeout("3 seconds"))
      expect(observations.at(-1)).toMatchObject({
        status: "available",
        queues: [{ recoveryNeeded: 0, terminal: 1 }],
      })
      yield* Fiber.interrupt(fiber)
    }),
  ))

it("stops its maintenance loop when publication fails before an observer restart", () =>
  withQueue(
    Effect.gen(function* () {
      const maintenance = yield* SqliteQueueMaintenance
      let recoveries = 0
      const result = yield* observeQueueHealth(() => {
        // Both the sample and its unavailable fallback fail, as when the
        // supervisor's state-file publisher temporarily cannot write.
        throw new Error("state publication unavailable")
      }).pipe(
        Effect.provideService(SqliteQueueMaintenance, {
          ...maintenance,
          recover: () =>
            Effect.sync(() => {
              recoveries++
            }).pipe(Effect.andThen(maintenance.recover())),
        }),
        Effect.exit,
      )
      expect(Exit.isFailure(result)).toBe(true)
      yield* Effect.sleep(50)
      const stoppedAt = recoveries
      // The retrying supervisor keeps this parent fiber alive. A child tied
      // only to that fiber would run again alongside the replacement observer.
      yield* Effect.sleep(1100)
      expect(recoveries).toBe(stoppedAt)
    }),
  ))

it("validates all finite observation bounds and supplies documented defaults", async () => {
  expect(await Effect.runPromise(readQueueObservationPolicy({}))).toEqual({
    sampleMs: 1000,
    waitingMs: 60000,
    warningIntervalMs: 60000,
  })
  for (const name of [
    "PF_LOCAL_QUEUE_SAMPLE_MS",
    "PF_LOCAL_QUEUE_WAIT_WARNING_MS",
    "PF_LOCAL_QUEUE_WARNING_INTERVAL_MS",
  ]) {
    for (const value of [
      "",
      "0",
      "-1",
      "NaN",
      "Infinity",
      "1.5",
      "2147483648",
      "10ms",
    ]) {
      const result = await Effect.runPromise(
        readQueueObservationPolicy({ [name]: value }).pipe(Effect.result),
      )
      expect(Result.isFailure(result)).toBe(true)
    }
  }
})
