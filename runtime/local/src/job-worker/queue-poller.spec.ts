import { existsSync, unlinkSync } from "node:fs"
import { AcknowledgeError, QueueService } from "@processfocus/runtime"
import { eq } from "drizzle-orm"
import {
  DateTime,
  Deferred,
  Duration,
  Effect,
  Either,
  Fiber,
  FiberRef,
  Layer,
  LogLevel,
  Logger,
  Option,
  Schema,
  TestClock,
  TestContext,
} from "effect"
import * as schema from "@pf/drizzle-sqlite"
import { UserDetails, type UserDetailsValue } from "@pf/graphql-db-operations"
import { ScheduledFlowNotFoundError } from "@pf/job-handler"
import { RequestTime } from "@pf/request-time"
import {
  DatabaseTest,
  TypedSqliteDrizzle,
} from "@pf/service-drizzle-sqlite/test"
import {
  DatabaseTestFile,
  generateTempDbPath,
} from "@pf/service-drizzle-sqlite/test-file"
import { SqliteQueueServiceLive } from "@pf/sqlite-queue-service"
import {
  claimNextLocalJob,
  createSingleQueuePoller,
  getIdlePollStage,
  getPollErrorDelay,
  processClaimedJob,
} from "./queue-poller"
import { jobHandler } from "./types"
import { Database } from "bun:sqlite"
import { describe, expect, it } from "bun:test"

const RequestTimeLive = Layer.succeed(
  RequestTime,
  FiberRef.unsafeMake(DateTime.unsafeMake(Date.now())),
)

const UserDetailsLive = Layer.succeed(
  UserDetails,
  FiberRef.unsafeMake({
    by: "TEST_USER",
    id: "usr-test",
  }) as FiberRef.FiberRef<UserDetailsValue>,
)

const QueueTest = SqliteQueueServiceLive.pipe(
  Layer.provideMerge(
    Layer.mergeAll(RequestTimeLive, UserDetailsLive, DatabaseTest),
  ),
)

const TestLayer = Layer.mergeAll(
  QueueTest,
  RequestTimeLive,
  UserDetailsLive,
  DatabaseTest,
)

const deleteIfExists = (path: string) => {
  if (existsSync(path)) {
    unlinkSync(path)
  }
}

describe("claimNextLocalJob", () => {
  it("does not take a writer lock when watched queues are idle", async () => {
    const dbPath = generateTempDbPath()
    const queueName = `idle-queue-${Date.now()}`

    try {
      const program = Effect.scoped(
        Effect.gen(function* () {
          // Hold a writer lock on a separate connection while the poller uses
          // the layer-backed connection under test.
          const lockDb = new Database(dbPath)
          let transactionStarted = false

          try {
            lockDb.run("PRAGMA journal_mode = WAL")
            lockDb.run("PRAGMA busy_timeout = 0")
            lockDb.run("BEGIN IMMEDIATE")
            transactionStarted = true

            const claimed = yield* claimNextLocalJob([queueName])

            expect(Option.isNone(claimed)).toBe(true)
          } finally {
            if (transactionStarted) {
              lockDb.run("ROLLBACK")
            }
            lockDb.close()
          }
        }),
      )

      await Effect.runPromise(
        program.pipe(Effect.provide(DatabaseTestFile(dbPath))),
      )
    } finally {
      deleteIfExists(dbPath)
      deleteIfExists(`${dbPath}-wal`)
      deleteIfExists(`${dbPath}-shm`)
    }
  }, 30_000)

  it("atomically claims the newest ready job across watched queues", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle
        const suffix = Date.now()
        const olderQueue = `atomic-older-${suffix}`
        const newerQueue = `atomic-newer-${suffix}`
        const olderAvailableAt = DateTime.unsafeMake(Date.now() - 2000)
        const newerAvailableAt = DateTime.unsafeMake(Date.now() - 1000)

        yield* db.insert(schema.jobQueue).values([
          {
            id: `qjob-older-${suffix}`,
            queue: olderQueue,
            jobPayload: { sequence: "older" },
            availableAt: olderAvailableAt,
          },
          {
            id: `qjob-newer-${suffix}`,
            queue: newerQueue,
            jobPayload: { sequence: "newer" },
            availableAt: newerAvailableAt,
          },
        ])

        const claimed = yield* claimNextLocalJob([olderQueue, newerQueue])

        expect(Option.isSome(claimed)).toBe(true)
        if (Option.isNone(claimed)) {
          return
        }

        expect(claimed.value.queue).toBe(newerQueue)
        expect(claimed.value.attempts).toBe(1)

        const claimedRow = yield* db
          .select({
            jobAttempts: schema.jobQueue.jobAttempts,
            lockedUntil: schema.jobQueue.lockedUntil,
          })
          .from(schema.jobQueue)
          .where(eq(schema.jobQueue.id, claimed.value.jobId))

        expect(claimedRow[0]?.jobAttempts).toBe(1)
        expect(claimedRow[0]?.lockedUntil).not.toBeNull()
      }),
    )

    await Effect.runPromise(
      program.pipe(Effect.provide(TestLayer)) as Effect.Effect<
        void,
        unknown,
        never
      >,
    )
  })
})

describe("createSingleQueuePoller", () => {
  it("pauses claims while the local queue pause token exists", async () => {
    const queueName = `paused-queue-${Date.now()}`

    const program = Effect.scoped(
      Effect.gen(function* () {
        const queueService = yield* QueueService
        const db = yield* TypedSqliteDrizzle
        const semaphore = yield* Effect.makeSemaphore(1)
        const pausedStateObserved = yield* Deferred.make<void>()

        yield* queueService.enqueue(queueName, { value: "ready" })

        const fiber = yield* Effect.fork(
          createSingleQueuePoller(
            {
              [queueName]: jobHandler({
                schema: Schema.Struct({ value: Schema.String }),
                handle: () => Effect.void,
              }),
            },
            semaphore,
            {
              onWorkerStateChange: (state) =>
                state.paused
                  ? Deferred.succeed(pausedStateObserved, undefined).pipe(
                      Effect.asVoid,
                    )
                  : Effect.void,
              readPauseToken: () => "paused",
            },
          ),
        )

        yield* Deferred.await(pausedStateObserved).pipe(
          Effect.timeoutFail({
            duration: Duration.millis(1500),
            onTimeout: () =>
              new Error("Timed out waiting for local queue poller to pause"),
          }),
        )

        yield* Fiber.interrupt(fiber)

        const row = yield* db
          .select({
            jobAttempts: schema.jobQueue.jobAttempts,
            lockedUntil: schema.jobQueue.lockedUntil,
          })
          .from(schema.jobQueue)
          .where(eq(schema.jobQueue.queue, queueName))

        expect(row[0]?.jobAttempts).toBe(0)
        expect(row[0]?.lockedUntil).toBeNull()
      }),
    )

    await Effect.runPromise(
      program.pipe(Effect.provide(TestLayer)) as Effect.Effect<
        void,
        unknown,
        never
      >,
    )
  })

  it("stamps worker state updatedAt from Effect Clock", async () => {
    const fixedMs = Date.parse("2020-01-15T12:00:00.000Z")
    const fixedTime = DateTime.unsafeMake(fixedMs)
    const queueName = `clock-updated-at-${Date.now()}`

    const program = Effect.scoped(
      Effect.gen(function* () {
        // Keep RequestTime aligned with TestClock: enqueue stamps availableAt
        // from RequestTime while the poller claims with DateTime.now.
        yield* TestClock.setTime(fixedMs)
        const requestTime = yield* RequestTime
        yield* FiberRef.set(requestTime, fixedTime)

        const queueService = yield* QueueService
        const semaphore = yield* Effect.makeSemaphore(1)
        const updatedAtSeen = yield* Deferred.make<string>()

        yield* queueService.enqueue(queueName, { value: "ready" })

        const fiber = yield* Effect.fork(
          createSingleQueuePoller(
            {
              [queueName]: jobHandler({
                schema: Schema.Struct({ value: Schema.String }),
                handle: () => Effect.void,
              }),
            },
            semaphore,
            {
              onWorkerStateChange: (state) =>
                state.activeJobs > 0
                  ? Deferred.succeed(updatedAtSeen, state.updatedAt).pipe(
                      Effect.catchAll(() => Effect.void),
                    )
                  : Effect.void,
            },
          ),
        )

        // TestClock only runs suspended fibers when time advances.
        for (let step = 0; step < 40; step += 1) {
          yield* TestClock.adjust(Duration.millis(50))
          if (yield* Deferred.isDone(updatedAtSeen)) {
            break
          }
        }

        expect(yield* Deferred.isDone(updatedAtSeen)).toBe(true)
        const updatedAt = yield* Deferred.await(updatedAtSeen)
        yield* Fiber.interrupt(fiber)

        expect(updatedAt).toBe("2020-01-15T12:00:00.000Z")
      }),
    )

    await Effect.runPromise(
      program.pipe(
        Effect.provide(TestLayer),
        Effect.provide(TestContext.TestContext),
      ) as Effect.Effect<void, unknown, never>,
    )
  })

  it("advances idle backoff stages under TestClock", async () => {
    const queueName = `idle-backoff-${Date.now()}`
    const capturedLogs: string[] = []
    const captureLogger = Logger.make(({ message }) => {
      const text = Array.isArray(message) ? message.join(" ") : String(message)
      capturedLogs.push(text)
    })

    const program = Effect.scoped(
      Effect.gen(function* () {
        // Align RequestTime with the TestClock epoch so enqueued jobs are
        // immediately claimable under deterministic time.
        const requestTime = yield* RequestTime
        yield* FiberRef.set(requestTime, DateTime.unsafeMake(0))

        const queueService = yield* QueueService
        const semaphore = yield* Effect.makeSemaphore(1)
        const jobStarted = yield* Deferred.make<void>()

        yield* queueService.enqueue(queueName, { value: "ready" })

        const fiber = yield* Effect.fork(
          createSingleQueuePoller(
            {
              [queueName]: jobHandler({
                schema: Schema.Struct({ value: Schema.String }),
                handle: () =>
                  Deferred.succeed(jobStarted, undefined).pipe(
                    Effect.catchAll(() => Effect.void),
                  ),
              }),
            },
            semaphore,
          ).pipe(
            Logger.withMinimumLogLevel(LogLevel.Debug),
            Effect.provide(Logger.replace(Logger.defaultLogger, captureLogger)),
          ),
        )

        // Drive the forked poller; TestClock only schedules work on adjust.
        for (let step = 0; step < 40; step += 1) {
          yield* TestClock.adjust(Duration.millis(50))
          if (yield* Deferred.isDone(jobStarted)) {
            break
          }
        }
        expect(yield* Deferred.isDone(jobStarted)).toBe(true)

        const hasStageLog = (label: string) =>
          capturedLogs.some((line) =>
            line.includes(`Local queue poller idle backoff now ${label}`),
          )

        // After a successful claim, idle starts at the 500ms stage.
        let first500msAt: number | null = null
        for (let step = 0; step < 80 && first500msAt === null; step += 1) {
          yield* TestClock.adjust(Duration.millis(250))
          if (hasStageLog("500ms")) {
            first500msAt = DateTime.toEpochMillis(yield* DateTime.now)
          }
        }
        expect(first500msAt).not.toBeNull()
        expect(hasStageLog("1s")).toBe(false)

        // Stay under the 30s idle boundary: the 1s stage must not appear yet.
        for (let step = 0; step < 20; step += 1) {
          yield* TestClock.adjust(Duration.millis(250))
          expect(hasStageLog("1s")).toBe(false)
        }

        // Cross the 30s idle boundary (5s already advanced above + 26s).
        yield* TestClock.adjust(Duration.seconds(26))

        let first1sAt: number | null = null
        for (let step = 0; step < 40 && first1sAt === null; step += 1) {
          yield* TestClock.adjust(Duration.millis(250))
          if (hasStageLog("1s")) {
            first1sAt = DateTime.toEpochMillis(yield* DateTime.now)
          }
        }

        yield* Fiber.interrupt(fiber)

        expect(first1sAt).not.toBeNull()
        // 1s stage only after ~30s of Effect Clock idle from the 500ms stage.
        expect((first1sAt ?? 0) - (first500msAt ?? 0)).toBeGreaterThanOrEqual(
          Duration.toMillis(Duration.seconds(30)),
        )
      }),
    )

    await Effect.runPromise(
      program.pipe(
        Effect.provide(TestLayer),
        Effect.provide(TestContext.TestContext),
      ) as Effect.Effect<void, unknown, never>,
    )
  })
})

describe("processClaimedJob", () => {
  it("records acknowledgement failures as job failures", async () => {
    const capturedLogs: string[] = []
    const captureLogger = Logger.make(({ message }) => {
      const text = Array.isArray(message) ? message.join(" ") : String(message)
      capturedLogs.push(text)
    })

    const program = Effect.scoped(
      Effect.gen(function* () {
        const queueService = yield* QueueService
        const queueName = `acknowledgement-failure-${Date.now()}`

        yield* queueService.enqueue(queueName, { value: "ok" })
        const job = yield* queueService.rawClaim(queueName)
        expect(Option.isSome(job)).toBe(true)
        if (Option.isNone(job)) {
          return
        }

        const failingQueue = QueueService.of({
          ...queueService,
          acknowledge: (jobId) =>
            Effect.fail(
              new AcknowledgeError({
                jobId,
                message: "simulated acknowledgement failure",
              }),
            ),
        })
        const result = yield* processClaimedJob(job.value, {
          [queueName]: jobHandler({
            schema: Schema.Struct({ value: Schema.String }),
            handle: () => Effect.void,
          }),
        }).pipe(
          Effect.provideService(QueueService, failingQueue),
          Effect.provide(Logger.replace(Logger.defaultLogger, captureLogger)),
          Effect.either,
        )

        expect(Either.isLeft(result)).toBe(true)
        expect(
          capturedLogs.some((line) =>
            line.includes(`Job ${job.value.jobId} acknowledgement failed:`),
          ),
        ).toBe(true)
      }),
    )

    await Effect.runPromise(
      program.pipe(Effect.provide(TestLayer)) as Effect.Effect<
        void,
        unknown,
        never
      >,
    )
  })

  it("dead-letters malformed payloads instead of retrying them", async () => {
    const handledJobs: string[] = []

    const program = Effect.scoped(
      Effect.gen(function* () {
        const queueService = yield* QueueService
        const db = yield* TypedSqliteDrizzle
        const queueName = `malformed-payload-${Date.now()}`

        yield* queueService.enqueue(queueName, { todoId: "stale-shape" })

        const job = yield* queueService.rawClaim(queueName)
        expect(Option.isSome(job)).toBe(true)
        if (Option.isNone(job)) {
          return
        }

        yield* processClaimedJob(job.value, {
          [queueName]: jobHandler({
            schema: Schema.Struct({ todoIds: Schema.Array(Schema.String) }),
            handle: (job: { jobId: string }) =>
              Effect.sync(() => {
                handledJobs.push(job.jobId)
              }),
          }),
        })

        const stats = yield* queueService.getStats(queueName)
        expect(stats.deadLetter).toBe(1)

        const row = yield* db
          .select({
            jobAttempts: schema.jobQueue.jobAttempts,
            jobRetryLimit: schema.jobQueue.jobRetryLimit,
            lockedUntil: schema.jobQueue.lockedUntil,
          })
          .from(schema.jobQueue)
          .where(eq(schema.jobQueue.queue, queueName))

        expect(row).toHaveLength(1)
        expect(row[0]?.jobAttempts).toBe(row[0]?.jobRetryLimit)
        expect(row[0]?.lockedUntil).toBeNull()
        expect(handledJobs).toEqual([])

        const claimedAgain = yield* queueService.rawClaim(queueName)
        expect(Option.isNone(claimedAgain)).toBe(true)
      }),
    )

    await Effect.runPromise(
      program.pipe(Effect.provide(TestLayer)) as Effect.Effect<
        void,
        unknown,
        never
      >,
    )
  })

  it("keeps the job locked when the scheduled flow is not yet visible", async () => {
    const capturedLogs: string[] = []
    const captureLogger = Logger.make(({ message }) => {
      const text = Array.isArray(message) ? message.join(" ") : String(message)
      capturedLogs.push(text)
    })

    const program = Effect.scoped(
      Effect.gen(function* () {
        const queueService = yield* QueueService
        const db = yield* TypedSqliteDrizzle
        const queueName = `scheduled-flow-missing-${Date.now()}`
        const scheduledFlowId = `sf-missing-${Date.now()}`

        yield* queueService.enqueue(queueName, { scheduledFlowId })

        const job = yield* queueService.rawClaim(queueName)
        expect(Option.isSome(job)).toBe(true)
        if (Option.isNone(job)) {
          return
        }

        // Distinguishes the special retry branch from generic fail(locked):
        // info "will retry" log and no "failed" error log / fail path.
        yield* processClaimedJob(job.value, {
          [queueName]: jobHandler({
            schema: Schema.Struct({ scheduledFlowId: Schema.String }),
            handle: () =>
              Effect.fail(new ScheduledFlowNotFoundError({ scheduledFlowId })),
          }),
        }).pipe(
          Effect.provide(Logger.replace(Logger.defaultLogger, captureLogger)),
        )

        expect(
          capturedLogs.some((line) =>
            line.includes("will retry: scheduled flow not yet visible"),
          ),
        ).toBe(true)
        expect(capturedLogs.some((line) => /Job .+ failed:/.test(line))).toBe(
          false,
        )

        const stats = yield* queueService.getStats(queueName)
        expect(stats.deadLetter).toBe(0)

        const row = yield* db
          .select({
            jobAttempts: schema.jobQueue.jobAttempts,
            lockedUntil: schema.jobQueue.lockedUntil,
          })
          .from(schema.jobQueue)
          .where(eq(schema.jobQueue.queue, queueName))

        expect(row).toHaveLength(1)
        expect(row[0]?.jobAttempts).toBe(1)
        expect(row[0]?.lockedUntil).not.toBeNull()

        // Still locked for visibility-timeout retry; not re-claimable yet.
        const claimedAgain = yield* queueService.rawClaim(queueName)
        expect(Option.isNone(claimedAgain)).toBe(true)
      }),
    )

    await Effect.runPromise(
      program.pipe(Effect.provide(TestLayer)) as Effect.Effect<
        void,
        unknown,
        never
      >,
    )
  })
})

describe("getIdlePollStage", () => {
  it("uses the expected staged idle backoff", () => {
    expect(getIdlePollStage(Duration.seconds(0)).label).toBe("500ms")
    expect(getIdlePollStage(Duration.seconds(29)).label).toBe("500ms")
    expect(getIdlePollStage(Duration.seconds(30)).label).toBe("1s")
    expect(getIdlePollStage(Duration.seconds(59)).label).toBe("1s")
    expect(getIdlePollStage(Duration.seconds(60)).label).toBe("2s")
    expect(getIdlePollStage(Duration.seconds(119)).label).toBe("2s")
    expect(getIdlePollStage(Duration.seconds(120)).label).toBe("3s")
  })
})

describe("getPollErrorDelay", () => {
  it("ramps poll retry delays and caps them", () => {
    expect(Duration.toMillis(getPollErrorDelay(1))).toBe(250)
    expect(Duration.toMillis(getPollErrorDelay(2))).toBe(500)
    expect(Duration.toMillis(getPollErrorDelay(3))).toBe(1000)
    expect(Duration.toMillis(getPollErrorDelay(10))).toBe(1000)
  })
})
