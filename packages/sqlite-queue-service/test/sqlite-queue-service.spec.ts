import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  EnqueueError,
  InvalidQueueNameError,
  QueueService,
  StaleJobClaimError,
} from "@processfocus/runtime"
import {
  Clock,
  ConfigProvider,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Option,
  Result,
} from "effect"
import { SqlClient, Statement } from "effect/sql"
import { TestClock } from "effect/testing"
import { UserDetails, type UserDetailsValue } from "@pf/graphql-db-operations"
import { makeTursoLive } from "@pf/layer-turso-local"
import { RequestTime } from "@pf/request-time"
import {
  DatabaseTest,
  MigrationsFolderConfig,
  SqliteTest,
  TypedSqliteDrizzleLayer,
  runSqliteTestMigrations,
} from "@pf/service-drizzle-sqlite/test"
import { batchQueueCases } from "../../runtime/test/batch-contract"
import {
  SqliteQueueMaintenance,
  SqliteQueueServiceLive,
} from "../src/lib/sqlite-queue-service"
import { describe, expect, it } from "bun:test"

const RequestTimeLive = Layer.succeed(
  RequestTime,
  DateTime.makeUnsafe(Date.now()),
)

const UserDetailsLive = Layer.succeed(UserDetails, {
  by: "TEST_USER",
  id: "usr-test",
} as UserDetailsValue)

describe("SqliteQueueService", () => {
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

  type TestRequirements = Layer.Success<typeof TestLayer>

  const runTest = <A, E>(
    test: Effect.Effect<A, E, TestRequirements>,
  ): Promise<A> => {
    return Effect.runPromise(Effect.provide(test, TestLayer))
  }

  for (const { name, run } of batchQueueCases) {
    it(name, () => runTest(run))
  }

  describe("enqueue", () => {
    it("should enqueue a job and return job ID", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService

          const jobId = yield* queue.enqueue("test-queue", { task: "test" })

          expect(jobId).toBeDefined()
          expect(typeof jobId).toBe("string")
          expect(jobId.length).toBeGreaterThan(0)
        }),
      ))

    it("should enqueue jobs with different payloads", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService

          const jobId1 = yield* queue.enqueue("test-queue", { task: "task1" })
          const jobId2 = yield* queue.enqueue("test-queue", { task: "task2" })

          expect(jobId1).not.toBe(jobId2)
        }),
      ))

    it("keeps logical job IDs separate from physical queue IDs", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const logicalJobId = `execution-event:restart:${"x".repeat(80)}`

          const firstId = yield* queue.enqueue(
            "logical-id-queue",
            { task: "first" },
            { logicalJobId },
          )
          const secondId = yield* queue.enqueue(
            "logical-id-queue",
            { task: "second" },
            { logicalJobId },
          )
          const firstDelayedId = yield* queue.enqueueWithDelay(
            "logical-id-delay-queue",
            { task: "first-delayed" },
            Duration.seconds(1),
            { logicalJobId },
          )
          const secondDelayedId = yield* queue.enqueueWithDelay(
            "logical-id-delay-queue",
            { task: "second-delayed" },
            Duration.seconds(1),
            { logicalJobId },
          )

          expect(firstId).not.toBe(logicalJobId)
          expect(secondId).not.toBe(logicalJobId)
          expect(firstId).not.toBe(secondId)
          expect(firstDelayedId).not.toBe(logicalJobId)
          expect(secondDelayedId).not.toBe(logicalJobId)
          expect(firstDelayedId).not.toBe(secondDelayedId)
        }),
      ))

    it("should enqueue and claim a job", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService

          yield* queue.enqueue("retry-queue", { task: "test" })

          // Claim the job
          const job = yield* queue.rawClaim("retry-queue")
          expect(Option.isSome(job)).toBe(true)
          if (Option.isSome(job)) {
            expect(job.value.attempts).toBe(1)
          }
        }),
      ))
  })

  describe("enqueueWithDelay", () => {
    it("should enqueue a job with delay", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService

          const jobId = yield* queue.enqueueWithDelay(
            "delayed-queue",
            { task: "delayed" },
            Duration.seconds(60),
          )

          expect(jobId).toBeDefined()

          // Job should not be claimable immediately
          const job = yield* queue.rawClaim("delayed-queue")
          expect(Option.isNone(job)).toBe(true)
        }),
      ))
  })

  describe("claim", () => {
    it("should claim an available job", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService

          const jobId = yield* queue.enqueue("claim-queue", {
            task: "to-claim",
          })
          const job = yield* queue.rawClaim("claim-queue")

          expect(Option.isSome(job)).toBe(true)
          if (Option.isSome(job)) {
            expect(job.value.jobId).toBe(jobId)
            expect(job.value.payload).toEqual({ task: "to-claim" })
            expect(job.value.attempts).toBe(1)
          }
        }),
      ))

    it("claims with a literal LIMIT so Turso's argument count matches", async () => {
      const recorded: Array<{
        readonly sql: string
        readonly params: ReadonlyArray<unknown> | undefined
      }> = []
      const RecordingSqlLive = Layer.effect(
        SqlClient.SqlClient,
        Effect.map(SqlClient.SqlClient, (client) => {
          const wrapped = Object.assign(
            (strings: TemplateStringsArray, ...args: Array<unknown>) =>
              client(strings, ...args),
            client,
            {
              unsafe: (query: string, params?: ReadonlyArray<unknown>) => {
                recorded.push({ sql: query, params })
                return client.unsafe(query, params)
              },
            },
          )
          return wrapped
        }),
      ).pipe(Layer.provide(SqliteTest))
      const MigrationLive = Layer.effectDiscard(
        Effect.gen(function* () {
          const migrationsFolder = yield* MigrationsFolderConfig
          yield* runSqliteTestMigrations(migrationsFolder)
        }),
      ).pipe(Layer.provide(SqliteTest))
      const layer = SqliteQueueServiceLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            RecordingSqlLive,
            TypedSqliteDrizzleLayer.pipe(Layer.provide(RecordingSqlLive)),
            RequestTimeLive,
            UserDetailsLive,
            MigrationLive,
          ),
        ),
      )

      await Effect.runPromise(
        Effect.gen(function* () {
          const queue = yield* QueueService
          yield* queue.enqueue("turso-limit-queue", { task: "notify" })
          const jobs = yield* queue.rawClaimBatch("turso-limit-queue", 16)
          expect(jobs).toHaveLength(1)
        }).pipe(Effect.provide(layer)),
      )

      const update = recorded.find((statement) =>
        statement.sql.startsWith("update "),
      )
      expect(update).toBeDefined()
      expect(update?.sql).toContain("limit 16")
      expect(update?.sql).not.toContain("limit ?")
      expect(update?.sql.match(/\?/g)?.length).toBe(update?.params?.length)
    })

    it("should return None when no jobs available", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService

          const job = yield* queue.rawClaim("empty-queue")

          expect(Option.isNone(job)).toBe(true)
        }),
      ))

    it("should not claim already claimed job", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService

          yield* queue.enqueue("single-claim-queue", { task: "test" })

          const job1 = yield* queue.rawClaim("single-claim-queue")
          const job2 = yield* queue.rawClaim("single-claim-queue")

          expect(Option.isSome(job1)).toBe(true)
          expect(Option.isNone(job2)).toBe(true)
        }),
      ))

    it("should increment attempts on each claim", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService

          yield* queue.enqueue("attempts-queue", { task: "test" })

          // First claim
          const job1 = yield* queue.rawClaim(
            "attempts-queue",
            Duration.millis(1),
          )
          expect(Option.isSome(job1)).toBe(true)
          if (Option.isSome(job1)) {
            expect(job1.value.attempts).toBe(1)
          }

          // Wait for visibility timeout to expire
          yield* Effect.sleep(Duration.millis(10))

          // Second claim after timeout
          const job2 = yield* queue.rawClaim(
            "attempts-queue",
            Duration.millis(1),
          )
          expect(Option.isSome(job2)).toBe(true)
          if (Option.isSome(job2)) {
            expect(job2.value.attempts).toBe(2)
          }
        }),
      ))

    it("should replace the receipt on every claim", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const queueName = `receipt-queue-${Date.now()}`
          yield* queue.enqueue(queueName, { task: "test" })

          const first = yield* queue.rawClaim(queueName, Duration.millis(1))
          expect(Option.isSome(first)).toBe(true)
          yield* Effect.sleep(Duration.millis(10))
          const second = yield* queue.rawClaim(queueName, Duration.seconds(1))
          expect(Option.isSome(second)).toBe(true)

          if (Option.isSome(first) && Option.isSome(second)) {
            expect(first.value.receipt).not.toBe(second.value.receipt)
          }
        }),
      ))

    it("should prefer fresh jobs over retried jobs", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const queueName = `retry-order-queue-${Date.now()}`

          yield* queue.enqueue(queueName, { task: "retried" })

          const firstClaim = yield* queue.rawClaim(
            queueName,
            Duration.seconds(60),
          )
          expect(Option.isSome(firstClaim)).toBe(true)
          if (Option.isSome(firstClaim)) {
            yield* queue.fail(
              firstClaim.value.jobId,
              firstClaim.value.receipt,
              {
                releaseImmediately: true,
              },
            )
          }

          yield* queue.enqueue(queueName, { task: "fresh" })

          const nextClaim = yield* queue.rawClaim(
            queueName,
            Duration.seconds(60),
          )
          expect(Option.isSome(nextClaim)).toBe(true)
          if (Option.isSome(nextClaim)) {
            expect(nextClaim.value.payload).toEqual({ task: "fresh" })
            expect(nextClaim.value.attempts).toBe(1)
          }
        }),
      ))

    it("should not claim jobs that exceeded max retries", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const queueName = `max-retry-queue-${Date.now()}`

          yield* queue.enqueue(queueName, { task: "test" })

          // Claim 5 times (default maxRetries = 5, exhaust retries)
          for (let i = 0; i < 5; i++) {
            const job = yield* queue.rawClaim(queueName, Duration.millis(1))
            expect(Option.isSome(job)).toBe(true)
            yield* Effect.sleep(Duration.millis(10))
          }

          // Sixth claim should fail (max retries = 5)
          const job6 = yield* queue.rawClaim(queueName)
          expect(Option.isNone(job6)).toBe(true)
        }),
      ))
  })

  describe("acknowledge", () => {
    it("should acknowledge and remove job from queue", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService

          yield* queue.enqueue("ack-queue", { task: "test" })
          const claimed = yield* queue.rawClaim("ack-queue")
          if (Option.isNone(claimed)) return
          yield* queue.acknowledge(claimed.value.jobId, claimed.value.receipt)

          // Job should no longer be claimable
          const job = yield* queue.rawClaim("ack-queue")
          expect(Option.isNone(job)).toBe(true)
        }),
      ))

    it("should fail for non-existent job", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService

          const result = yield* Effect.result(
            queue.acknowledge("non-existent-id", "non-existent-receipt"),
          )

          expect(result._tag).toBe("Failure")
        }),
      ))
  })

  describe("fail", () => {
    it("should mark job as failed but keep it for retry", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService

          yield* queue.enqueue("fail-queue", { task: "test" })
          const job = yield* queue.rawClaim("fail-queue", Duration.seconds(60))

          expect(Option.isSome(job)).toBe(true)
          if (Option.isSome(job)) {
            yield* queue.fail(job.value.jobId, job.value.receipt)

            // Job should not be immediately claimable (still locked)
            const job2 = yield* queue.rawClaim("fail-queue")
            expect(Option.isNone(job2)).toBe(true)
          }
        }),
      ))

    it("should release job immediately with releaseImmediately option", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService

          yield* queue.enqueue("fail-immediate-queue", { task: "test" })
          const job = yield* queue.rawClaim(
            "fail-immediate-queue",
            Duration.seconds(60),
          )

          expect(Option.isSome(job)).toBe(true)
          if (Option.isSome(job)) {
            yield* queue.fail(job.value.jobId, job.value.receipt, {
              releaseImmediately: true,
            })

            // Job should be immediately claimable
            const job2 = yield* queue.rawClaim("fail-immediate-queue")
            expect(Option.isSome(job2)).toBe(true)
            if (Option.isSome(job2)) {
              expect(job2.value.attempts).toBe(2)
            }
          }
        }),
      ))

    it("should move a current claim directly to dead letter", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const queueName = `terminal-fail-queue-${Date.now()}`
          yield* queue.enqueue(queueName, { task: "test" })
          const job = yield* queue.rawClaim(queueName, Duration.seconds(60))
          expect(Option.isSome(job)).toBe(true)
          if (Option.isNone(job)) return

          yield* queue.fail(job.value.jobId, job.value.receipt, {
            retryable: false,
          })
          expect((yield* queue.getStats(queueName)).deadLetter).toBe(1)
        }),
      ))
  })

  describe("stale claims", () => {
    it("should reject every stale operation without changing the current lease", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const queueName = `stale-claim-queue-${Date.now()}`
          yield* queue.enqueue(queueName, { task: "test" }, { retryLimit: 10 })

          const stale = yield* queue.rawClaim(queueName, Duration.millis(1))
          expect(Option.isSome(stale)).toBe(true)
          yield* Effect.sleep(Duration.millis(10))
          const current = yield* queue.rawClaim(queueName, Duration.millis(100))
          expect(Option.isSome(current)).toBe(true)
          if (Option.isNone(stale) || Option.isNone(current)) return

          const operations = [
            queue.acknowledge(stale.value.jobId, stale.value.receipt),
            queue.fail(stale.value.jobId, stale.value.receipt),
            queue.fail(stale.value.jobId, stale.value.receipt, {
              releaseImmediately: true,
            }),
            queue.fail(stale.value.jobId, stale.value.receipt, {
              retryable: false,
            }),
            queue.extendVisibility(
              stale.value.jobId,
              stale.value.receipt,
              Duration.seconds(10),
            ),
          ]

          for (const operation of operations) {
            const result = yield* Effect.result(operation)
            Result.match(result, {
              onFailure: (error) =>
                expect(error).toBeInstanceOf(StaleJobClaimError),
              onSuccess: () => {
                throw new Error("Expected stale queue operation to fail")
              },
            })
            expect(yield* queue.getStats(queueName)).toEqual({
              pending: 0,
              processing: 1,
              deadLetter: 0,
            })
          }

          yield* Effect.sleep(Duration.millis(150))
          const reclaimed = yield* queue.rawClaim(
            queueName,
            Duration.seconds(1),
          )
          expect(Option.isSome(reclaimed)).toBe(true)
          if (Option.isSome(reclaimed)) {
            yield* queue.acknowledge(
              reclaimed.value.jobId,
              reclaimed.value.receipt,
            )
          }
        }),
      ))
  })

  describe("extendVisibility", () => {
    it("should set new visibility timeout from now", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService

          yield* queue.enqueue("extend-queue", { task: "test" })
          const job = yield* queue.rawClaim("extend-queue", Duration.millis(50))

          expect(Option.isSome(job)).toBe(true)
          if (Option.isSome(job)) {
            // Set visibility timeout to 10 seconds from now (SQS semantics)
            yield* queue.extendVisibility(
              job.value.jobId,
              job.value.receipt,
              Duration.seconds(10),
            )

            // Wait past original timeout
            yield* Effect.sleep(Duration.millis(60))

            // Job should still not be claimable due to new timeout
            const job2 = yield* queue.rawClaim("extend-queue")
            expect(Option.isNone(job2)).toBe(true)
          }
        }),
      ))

    it("should fail for non-existent job", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService

          const result = yield* Effect.result(
            queue.extendVisibility(
              "non-existent-id",
              "non-existent-receipt",
              Duration.seconds(10),
            ),
          )

          expect(result._tag).toBe("Failure")
        }),
      ))
  })

  describe("getStats", () => {
    it("should return queue statistics", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const queueName = `stats-queue-${Date.now()}`

          // Enqueue some jobs
          yield* queue.enqueue(queueName, { task: "pending1" })
          yield* queue.enqueue(queueName, { task: "pending2" })

          // Claim one to make it processing
          const claimed = yield* queue.rawClaim(queueName, Duration.seconds(60))
          expect(Option.isSome(claimed)).toBe(true)

          const stats = yield* queue.getStats(queueName)

          // After claiming 1 of 2 jobs:
          // - 1 job should be processing (has lockedUntil in future)
          // - 1 job should be pending (no lockedUntil or lockedUntil <= now)
          expect(stats.processing).toBe(1)
          expect(stats.pending).toBe(1)
          expect(stats.deadLetter).toBe(0)
        }),
      ))

    it("should count dead letter jobs", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const queueName = `dead-letter-queue-${Date.now()}`

          // Create a job with default maxRetries (5)
          yield* queue.enqueue(queueName, { task: "test" })

          // Claim it 5 times (exhausts retries)
          for (let i = 0; i < 5; i++) {
            yield* queue.rawClaim(queueName, Duration.millis(1))
            yield* Effect.sleep(Duration.millis(10))
          }

          expect((yield* queue.getStats(queueName)).deadLetter).toBe(0)
          const maintenance = yield* SqliteQueueMaintenance
          expect(yield* maintenance.recover()).toBeGreaterThanOrEqual(1)
          expect((yield* queue.getStats(queueName)).deadLetter).toBe(1)
        }),
      ))
  })

  describe("concurrency", () => {
    it("should handle concurrent enqueue operations", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const queueName = "concurrent-enqueue-queue"

          // Enqueue 10 jobs concurrently
          const jobIds = yield* Effect.all(
            Array.from({ length: 10 }, (_, i) =>
              queue.enqueue(queueName, { task: `task-${i}` }),
            ),
            { concurrency: 10 },
          )

          // All should have unique IDs
          const uniqueIds = new Set(jobIds)
          expect(uniqueIds.size).toBe(10)

          // All should be claimable
          const jobs: string[] = []
          for (let i = 0; i < 10; i++) {
            const job = yield* queue.rawClaim(queueName, Duration.millis(1))
            if (Option.isSome(job)) {
              jobs.push(job.value.jobId)
            }
            yield* Effect.sleep(Duration.millis(5))
          }
          expect(jobs.length).toBe(10)
        }),
      ))

    it("should not double-claim jobs under concurrent claim attempts", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const queueName = "concurrent-claim-queue"

          // Enqueue 5 jobs
          for (let i = 0; i < 5; i++) {
            yield* queue.enqueue(queueName, { task: `task-${i}` })
          }

          // Try to claim 10 times concurrently (more than available)
          const results = yield* Effect.all(
            Array.from({ length: 10 }, () =>
              queue.rawClaim(queueName, Duration.seconds(60)),
            ),
            { concurrency: 10 },
          )

          // Exactly 5 should succeed
          const successfulClaims = results.filter(Option.isSome)
          expect(successfulClaims.length).toBe(5)

          // All claimed jobs should be unique
          const claimedIds = successfulClaims.map((job) => job.value.jobId)
          const uniqueClaimedIds = new Set(claimedIds)
          expect(uniqueClaimedIds.size).toBe(5)
        }),
      ))
  })

  describe("queue name validation", () => {
    it("should reject enqueue with invalid queue name (spaces)", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const result = yield* Effect.result(
            queue.enqueue("invalid queue", { task: "test" }),
          )

          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") {
            expect(result.failure).toBeInstanceOf(InvalidQueueNameError)
            expect(result.failure.message).toContain("invalid characters")
          }
        }),
      ))

    it("should reject enqueue with invalid queue name (special chars)", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const result = yield* Effect.result(
            queue.enqueue("invalid@queue", { task: "test" }),
          )

          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") {
            expect(result.failure).toBeInstanceOf(InvalidQueueNameError)
          }
        }),
      ))

    it("should reject enqueue with empty queue name", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const result = yield* Effect.result(
            queue.enqueue("", { task: "test" }),
          )

          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") {
            expect(result.failure).toBeInstanceOf(InvalidQueueNameError)
            expect(result.failure.message).toContain("cannot be empty")
          }
        }),
      ))

    it("should reject enqueue with queue name exceeding max length", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const longName = "a".repeat(81)
          const result = yield* Effect.result(
            queue.enqueue(longName, { task: "test" }),
          )

          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") {
            expect(result.failure).toBeInstanceOf(InvalidQueueNameError)
            expect(result.failure.message).toContain("exceeds maximum length")
          }
        }),
      ))

    it("should reject enqueueWithDelay with invalid queue name", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const result = yield* Effect.result(
            queue.enqueueWithDelay(
              "invalid queue",
              { task: "test" },
              Duration.seconds(1),
            ),
          )

          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") {
            expect(result.failure).toBeInstanceOf(InvalidQueueNameError)
          }
        }),
      ))

    it("should reject claim with invalid queue name", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const result = yield* Effect.result(queue.rawClaim("invalid@queue"))

          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") {
            expect(result.failure).toBeInstanceOf(InvalidQueueNameError)
          }
        }),
      ))

    it("should accept valid queue names", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const validNames = [
            "test-queue",
            "test_queue",
            "test.queue",
            "TestQueue123",
            "a",
          ]

          for (const name of validNames) {
            const jobId = yield* queue.enqueue(name, { task: "test" })
            expect(jobId).toBeDefined()
          }
        }),
      ))

    it("should reject getStats with invalid queue name", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const result = yield* Effect.result(queue.getStats("invalid queue"))

          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") {
            expect(result.failure).toBeInstanceOf(InvalidQueueNameError)
          }
        }),
      ))
  })
})

describe("SqliteQueueService on Turso", () => {
  const runTest = async <A, E, E2 = never>(
    test:
      | Effect.Effect<
          A,
          E,
          QueueService | SqliteQueueMaintenance | SqlClient.SqlClient
        >
      | ((
          dbPath: string,
        ) => Effect.Effect<
          A,
          E,
          QueueService | SqliteQueueMaintenance | SqlClient.SqlClient
        >),
    afterClose?: Effect.Effect<
      void,
      E2,
      QueueService | SqliteQueueMaintenance | SqlClient.SqlClient
    >,
    busyTimeoutMs?: number,
  ): Promise<A> => {
    const directory = await mkdtemp(join(tmpdir(), "queue-ack-"))
    const SqlLive = (
      busyTimeoutMs === undefined
        ? makeTursoLive()
        : makeTursoLive({ busy_timeout: busyTimeoutMs })
    ).pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            SQLITE_DATABASE_PATH: `${directory}/pf.db`,
          }),
        ),
      ),
    )
    // Isolate the queue table; unrelated runtime tables and triggers are not needed.
    const Database = Layer.effectDiscard(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`CREATE TABLE pf_job_queue (
          id TEXT PRIMARY KEY NOT NULL,
          queue TEXT NOT NULL,
          job_payload TEXT NOT NULL,
          job_attempts INTEGER NOT NULL DEFAULT 0,
          job_retry_limit INTEGER NOT NULL DEFAULT 5,
          available_at REAL NOT NULL DEFAULT (julianday('now')),
          locked_until REAL,
          claim_receipt TEXT,
          created_at REAL NOT NULL DEFAULT (julianday('now')),
          updated_at REAL NOT NULL DEFAULT (julianday('now')),
          created_by TEXT NOT NULL DEFAULT 'SYSTEM',
          updated_by TEXT NOT NULL DEFAULT 'SYSTEM',
          _deleted INTEGER NOT NULL DEFAULT 0
        )`
        // Exercise the actual additive upgrade on the legacy queue table with
        // the local engine, not just a hand-copied post-upgrade schema.
        const migration = yield* Effect.promise(() =>
          readFile(
            new URL(
              "../../drizzle-sqlite/drizzle/20261024022040_magenta_dreaming_celestial/migration.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        )
        for (const statement of migration.split("--> statement-breakpoint")) {
          yield* sql.unsafe(statement)
        }
      }),
    ).pipe(
      Layer.provideMerge(
        TypedSqliteDrizzleLayer.pipe(Layer.provideMerge(SqlLive)),
      ),
    )
    const TestLayer = SqliteQueueServiceLive.pipe(
      Layer.provideMerge(
        Layer.mergeAll(Database, RequestTimeLive, UserDetailsLive),
      ),
    )
    try {
      const result = await Effect.runPromise(
        (typeof test === "function" ? test(`${directory}/pf.db`) : test).pipe(
          Effect.provide(TestLayer),
        ),
      )
      if (afterClose) {
        const Reopened = SqliteQueueServiceLive.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              TypedSqliteDrizzleLayer.pipe(Layer.provideMerge(SqlLive)),
              RequestTimeLive,
              UserDetailsLive,
            ),
          ),
        )
        await Effect.runPromise(afterClose.pipe(Effect.provide(Reopened)))
      }
      return result
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  it("records abandoned final claims after restart, protects live claims and explicitly redrives retained evidence", async () => {
    let abandoned = ""
    let live = ""
    await runTest(
      Effect.gen(function* () {
        const queue = yield* QueueService
        abandoned = yield* queue.enqueue(
          "restart-terminal",
          { task: "external-action" },
          { retryLimit: 0 },
        )
        const claim = Option.getOrThrow(
          yield* queue.rawClaim("restart-terminal", Duration.millis(1)),
        )
        live = yield* queue.enqueue("live-final", {}, { retryLimit: 0 })
        yield* queue.rawClaim("live-final", Duration.hours(1))
        const stats = yield* queue.getStats("live-final")
        expect(stats.processing).toBe(1)
        expect(stats.deadLetter).toBe(0)
        yield* Effect.sleep(Duration.millis(5))
        expect((yield* queue.getStats("restart-terminal")).deadLetter).toBe(0)
        expect(
          yield* Effect.result(queue.acknowledge(abandoned, claim.receipt)),
        ).toSatisfy(Result.isFailure)
      }),
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const queue = yield* QueueService
        const maintenance = yield* SqliteQueueMaintenance
        expect(yield* maintenance.recover()).toBe(1)
        const rows =
          yield* sql`SELECT * FROM pf_job_queue WHERE id = ${abandoned}`
        expect(rows[0]).toMatchObject({
          id: abandoned,
          queue: "restart-terminal",
          job_attempts: 1,
          terminal_outcome: "unknown",
        })
        expect(rows[0]?.["terminal_at"]).toBeNumber()
        expect(rows[0]?.["terminal_reason"]).toContain(
          "without a recorded outcome",
        )
        const [protectedRow] =
          yield* sql`SELECT * FROM pf_job_queue WHERE id = ${live}`
        expect(protectedRow?.["terminal_at"]).toBeNull()
        expect(Option.isNone(yield* queue.rawClaim("restart-terminal"))).toBe(
          true,
        )
        const id = yield* maintenance.redrive(abandoned)
        expect(id).not.toBe(abandoned)
        const [fresh] = yield* sql`SELECT * FROM pf_job_queue WHERE id = ${id}`
        expect(fresh).toMatchObject({
          redriven_from: abandoned,
          job_attempts: 0,
          job_retry_limit: 1,
          terminal_at: null,
        })
        const claimed = Option.getOrThrow(
          yield* queue.rawClaim("restart-terminal"),
        )
        expect(claimed.jobId).toBe(id)
        expect(claimed.payload).toEqual({ task: "external-action" })
        yield* queue.acknowledge(id, claimed.receipt)
        expect(yield* queue.getStats("restart-terminal")).toEqual({
          pending: 0,
          processing: 0,
          deadLetter: 1,
        })
        // A second deliberate invocation is new acceptance, not an idempotency
        // key or an automatic budget reset of the prior disposition.
        const secondId = yield* maintenance.redrive(abandoned)
        expect(secondId).not.toBe(id)
        expect(secondId).not.toBe(abandoned)
        const [second] =
          yield* sql`SELECT * FROM pf_job_queue WHERE id = ${secondId}`
        expect(second).toMatchObject({
          redriven_from: abandoned,
          job_attempts: 0,
          job_retry_limit: 1,
          terminal_at: null,
        })
        const secondClaim = Option.getOrThrow(
          yield* queue.rawClaim("restart-terminal"),
        )
        expect(secondClaim.jobId).toBe(secondId)
        yield* queue.acknowledge(secondId, secondClaim.receipt)
        expect(
          (yield* sql`SELECT * FROM pf_job_queue WHERE id = ${abandoned}`)[0],
        ).toEqual(rows[0])
      }),
    )
  })

  it.each([false, true])(
    "classifies diagnostic-free failure with non-retryable=%s",
    (nonRetryable) =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const sql = yield* SqlClient.SqlClient
          const id = yield* queue.enqueue(
            "failure-classification",
            {},
            { retryLimit: nonRetryable ? 4 : 0 },
          )
          const claim = Option.getOrThrow(
            yield* queue.rawClaim("failure-classification"),
          )
          yield* queue.fail(
            id,
            claim.receipt,
            nonRetryable ? { retryable: false } : { releaseImmediately: true },
          )
          const [row] = yield* sql`SELECT * FROM pf_job_queue WHERE id = ${id}`
          expect(row).toMatchObject({
            job_attempts: 1,
            terminal_outcome: nonRetryable ? "handler-failure" : "unknown",
            terminal_reason: nonRetryable
              ? "Non-retryable failure reported without a diagnostic reason"
              : "Attempt ended without a known handler outcome",
            claim_receipt: null,
            locked_until: null,
          })
          expect(row?.["terminal_at"]).toBeNumber()
          expect(
            Option.isNone(yield* queue.rawClaim("failure-classification")),
          ).toBe(true)
        }),
      ),
  )

  it("keeps terminal retirement atomic through failed writes and transaction interruption", () =>
    runTest(
      Effect.gen(function* () {
        const queue = yield* QueueService
        const sql = yield* SqlClient.SqlClient
        const maintenance = yield* SqliteQueueMaintenance
        const id = yield* queue.enqueue(
          "atomic-terminal",
          {},
          { retryLimit: 0 },
        )
        const claim = Option.getOrThrow(
          yield* queue.rawClaim("atomic-terminal"),
        )
        yield* sql`CREATE TRIGGER reject_terminal BEFORE UPDATE ON pf_job_queue
      WHEN NEW.terminal_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'terminal write interrupted'); END`
        expect(
          yield* Effect.result(
            queue.fail(id, claim.receipt, {
              reason: "handler rejected action",
            }),
          ),
        ).toSatisfy(Result.isFailure)
        let [row] = yield* sql`SELECT * FROM pf_job_queue WHERE id = ${id}`
        expect(row).toMatchObject({
          terminal_at: null,
          terminal_reason: null,
          claim_receipt: claim.receipt,
          job_attempts: 1,
        })
        yield* sql`DROP TRIGGER reject_terminal`
        const staged = yield* Deferred.make<void>()
        const transaction = yield* Effect.forkChild(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* queue.fail(id, claim.receipt, {
                reason: "handler rejected action",
              })
              yield* Deferred.succeed(staged, undefined)
              yield* Effect.never
            }),
          ),
        )
        yield* Deferred.await(staged)
        yield* Fiber.interrupt(transaction)
        ;[row] = yield* sql`SELECT * FROM pf_job_queue WHERE id = ${id}`
        expect(row?.["terminal_at"]).toBeNull()
        yield* queue.fail(id, claim.receipt, {
          reason: "handler rejected action",
        })
        ;[row] = yield* sql`SELECT * FROM pf_job_queue WHERE id = ${id}`
        expect(row).toMatchObject({
          job_attempts: 1,
          terminal_outcome: "handler-failure",
          terminal_reason: "handler rejected action",
          claim_receipt: null,
          locked_until: null,
        })
        expect(row?.["terminal_at"]).toBeNumber()
        expect(yield* maintenance.recover()).toBe(0)
        expect(Option.isNone(yield* queue.rawClaim("atomic-terminal"))).toBe(
          true,
        )
      }),
    ))

  it("recovers legacy exhausted rows without resurrecting receipts or resetting retry budgets", () =>
    runTest(
      Effect.gen(function* () {
        const queue = yield* QueueService
        const sql = yield* SqlClient.SqlClient
        const maintenance = yield* SqliteQueueMaintenance
        const id = yield* queue.enqueue("legacy-exhausted", {})
        yield* sql`UPDATE pf_job_queue SET job_attempts = job_retry_limit, locked_until = NULL, claim_receipt = NULL WHERE id = ${id}`
        expect((yield* queue.getStats("legacy-exhausted")).deadLetter).toBe(0)
        expect(yield* maintenance.recover()).toBe(1)
        expect(yield* maintenance.recover()).toBe(0)
        const [row] = yield* sql`SELECT * FROM pf_job_queue WHERE id = ${id}`
        expect(row).toMatchObject({
          job_attempts: 5,
          job_retry_limit: 5,
          terminal_outcome: "unknown",
        })
      }),
    ))

  it.each(
    (
      [
        "renew",
        "renew-live",
        "acknowledge",
        "release",
        "terminal",
        "batch",
      ] as const
    ).flatMap((operation) =>
      (["retry", "native", "inherited"] as const).map(
        (contention) => [operation, contention] as const,
      ),
    ),
  )(
    "checks current lease ownership for %s after %s writer contention",
    async (operation, contention) => {
      await runTest(
        (dbPath) =>
          Effect.gen(function* () {
            const queue = yield* QueueService
            const sql = yield* SqlClient.SqlClient
            const retrying = yield* Deferred.make<void>()
            const retry = yield* Deferred.make<void>()
            let now = 0
            let retries = 0
            const liveClock = Clock.Clock.defaultValue()
            const clock = Object.assign(Clock.Clock.defaultValue(), {
              currentTimeMillisUnsafe: () => now,
              currentTimeMillis: Effect.sync(() => now),
              currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
              currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
              sleep: (duration: Duration.Duration) => {
                retries++
                return contention === "retry"
                  ? Deferred.succeed(retrying, undefined).pipe(
                      Effect.andThen(Deferred.await(retry)),
                    )
                  : liveClock.sleep(duration)
              },
            })
            const id = yield* queue.enqueue("expiry-retry", {})
            const claim = yield* queue
              .rawClaim("expiry-retry", Duration.millis(1000))
              .pipe(Effect.provideService(Clock.Clock, clock))
            expect(Option.isSome(claim)).toBe(true)
            if (Option.isNone(claim)) return
            const receipt = claim.value.receipt
            const before = yield* sql<{
              locked_until: number
            }>`SELECT locked_until FROM pf_job_queue WHERE id = ${id}`
            const locked = yield* Deferred.make<void>()
            const unlock = yield* Deferred.make<void>()
            const blocker = yield* Effect.forkChild(
              Effect.gen(function* () {
                const other = yield* SqlClient.SqlClient
                yield* other.withTransaction(
                  Effect.gen(function* () {
                    yield* other`UPDATE pf_job_queue SET updated_by = 'blocker' WHERE id = ${id}`
                    yield* Deferred.succeed(locked, undefined)
                    yield* Deferred.await(unlock)
                  }),
                )
              }).pipe(
                Effect.provide(
                  makeTursoLive().pipe(
                    Layer.provide(
                      ConfigProvider.layer(
                        ConfigProvider.fromUnknown({
                          SQLITE_DATABASE_PATH: dbPath,
                        }),
                      ),
                    ),
                  ),
                ),
              ),
            )
            yield* Deferred.await(locked)
            now = 900
            let batchResult: readonly string[] | undefined
            const mutation =
              operation === "renew" || operation === "renew-live"
                ? queue.extendVisibility(id, receipt, Duration.millis(1000))
                : operation === "acknowledge"
                  ? queue.acknowledge(id, receipt)
                  : operation === "batch"
                    ? queue.acknowledgeBatch([{ jobId: id, receipt }]).pipe(
                        Effect.tap((ids) =>
                          Effect.sync(() => {
                            batchResult = ids
                          }),
                        ),
                        Effect.asVoid,
                      )
                    : queue.fail(
                        id,
                        receipt,
                        operation === "terminal"
                          ? { retryable: false }
                          : { releaseImmediately: true },
                      )
            const pending = yield* Effect.forkChild(
              (contention === "inherited"
                ? sql.withTransaction(mutation)
                : mutation
              ).pipe(Effect.provideService(Clock.Clock, clock), Effect.exit),
            )
            if (contention === "retry") yield* Deferred.await(retrying)
            else {
              // Keep the production-default native busy handler in flight. This
              // path must check expiry even without any Effect retry/sleep.
              yield* Effect.sleep(100)
            }
            now = operation === "renew-live" ? 950 : 1100
            yield* Deferred.succeed(unlock, undefined)
            yield* Fiber.join(blocker)
            yield* Deferred.succeed(retry, undefined)
            const result = yield* Fiber.join(pending)
            if (contention === "retry") expect(retries).toBeGreaterThan(0)
            else expect(retries).toBe(0)
            if (operation === "batch") {
              expect(Exit.isSuccess(result)).toBe(true)
              expect(batchResult).toEqual([])
            } else
              expect(Exit.isFailure(result)).toBe(operation !== "renew-live")
            const after = yield* sql<{
              locked_until: number
              claim_receipt: string
              job_attempts: number
            }>`SELECT locked_until, claim_receipt, job_attempts FROM pf_job_queue WHERE id = ${id}`
            expect(after).toHaveLength(1)
            if (operation === "renew-live")
              expect(after[0]!.locked_until).toBeGreaterThan(
                before[0]!.locked_until,
              )
            else expect(after[0]?.locked_until).toBe(before[0]?.locked_until)
            expect(after[0]?.claim_receipt).toBe(receipt)
            expect(after[0]?.job_attempts).toBe(1)
          }).pipe(
            Effect.scoped,
            Effect.provideService(RequestTime, DateTime.makeUnsafe(0)),
          ),
        undefined,
        contention === "retry" ? 1 : undefined,
      )
    },
  )

  it.each(["acknowledge", "renew", "new-claim"] as const)(
    "fences maintenance behind a winning %s transaction and rejects stale completion after retirement",
    (operation) =>
      runTest(
        Effect.scoped(
          Effect.gen(function* () {
            const queue = yield* QueueService
            const maintenance = yield* SqliteQueueMaintenance
            const sql = yield* SqlClient.SqlClient
            let now = 0
            const clock = Object.assign(Clock.Clock.defaultValue(), {
              currentTimeMillisUnsafe: () => now,
              currentTimeMillis: Effect.sync(() => now),
            })
            const id = yield* queue.enqueue(
              "recovery-race",
              {},
              { retryLimit: operation === "new-claim" ? 1 : 0 },
            )
            const old = Option.getOrThrow(
              yield* queue
                .rawClaim("recovery-race", Duration.millis(1000))
                .pipe(Effect.provideService(Clock.Clock, clock)),
            )
            const won = yield* Deferred.make<void>()
            const commit = yield* Deferred.make<void>()
            let receipt = old.receipt
            if (operation === "new-claim") now = 1100
            const winner = yield* Effect.forkChild(
              sql
                .withTransaction(
                  Effect.gen(function* () {
                    if (operation === "acknowledge")
                      yield* queue.acknowledge(id, old.receipt)
                    else if (operation === "renew")
                      yield* queue.extendVisibility(
                        id,
                        old.receipt,
                        Duration.millis(5000),
                      )
                    else
                      receipt = Option.getOrThrow(
                        yield* queue.rawClaim(
                          "recovery-race",
                          Duration.millis(5000),
                        ),
                      ).receipt
                    yield* Deferred.succeed(won, undefined)
                    yield* Deferred.await(commit)
                  }),
                )
                .pipe(Effect.provideService(Clock.Clock, clock)),
            )
            yield* Deferred.await(won)
            const recovery = yield* Effect.forkChild(
              maintenance
                .recover()
                .pipe(Effect.provideService(Clock.Clock, clock)),
            )
            yield* Effect.sleep(30)
            now = 1200
            yield* Deferred.succeed(commit, undefined)
            yield* Fiber.join(winner)
            expect(yield* Fiber.join(recovery)).toBe(0)
            if (operation === "acknowledge") {
              expect(
                yield* sql`SELECT id FROM pf_job_queue WHERE id = ${id}`,
              ).toEqual([])
              return
            }
            const [live] =
              yield* sql`SELECT * FROM pf_job_queue WHERE id = ${id}`
            expect(live?.["terminal_at"]).toBeNull()
            expect(live?.["claim_receipt"]).toBe(receipt)
            now = 10_000
            expect(
              yield* maintenance
                .recover()
                .pipe(Effect.provideService(Clock.Clock, clock)),
            ).toBe(1)
            expect(
              yield* Effect.result(queue.acknowledge(id, old.receipt)),
            ).toSatisfy(Result.isFailure)
            expect(
              yield* Effect.result(
                queue.extendVisibility(id, receipt, Duration.seconds(30)),
              ),
            ).toSatisfy(Result.isFailure)
            expect(
              yield* Effect.result(
                queue.fail(id, receipt, {
                  retryable: false,
                  reason: "late failure",
                }),
              ),
            ).toSatisfy(Result.isFailure)
            const [terminal] =
              yield* sql`SELECT * FROM pf_job_queue WHERE id = ${id}`
            expect(terminal?.["terminal_outcome"]).toBe("unknown")
            expect(terminal?.["job_attempts"]).toBe(
              operation === "new-claim" ? 2 : 1,
            )
          }),
        ).pipe(Effect.provideService(RequestTime, DateTime.makeUnsafe(0))),
      ),
  )

  it("keeps receipt mutations inside the caller's transaction", async () => {
    await runTest(
      Effect.gen(function* () {
        const queue = yield* QueueService
        const sql = yield* SqlClient.SqlClient
        const id = yield* queue.enqueue("caller-transaction", {})
        const claim = yield* queue.rawClaim("caller-transaction")
        expect(Option.isSome(claim)).toBe(true)
        if (Option.isNone(claim)) return
        const before = yield* sql<{
          locked_until: number
        }>`SELECT locked_until FROM pf_job_queue WHERE id = ${id}`
        const result = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* queue.extendVisibility(
                id,
                claim.value.receipt,
                Duration.minutes(5),
              )
              const inside = yield* sql<{
                locked_until: number
              }>`SELECT locked_until FROM pf_job_queue WHERE id = ${id}`
              expect(inside[0]!.locked_until).toBeGreaterThan(
                before[0]!.locked_until,
              )
              return yield* Effect.fail("caller rollback")
            }),
          )
          .pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
        const after = yield* sql<{
          locked_until: number
        }>`SELECT locked_until FROM pf_job_queue WHERE id = ${id}`
        expect(after).toEqual(before)
      }),
    )
  })

  it("rejects invalid admission before persistence and preserves valid attempt budgets on Turso", async () => {
    await runTest(
      Effect.gen(function* () {
        const queue = yield* QueueService
        const sql = yield* SqlClient.SqlClient
        for (const delayed of [false, true]) {
          const enqueue = (retryLimit: number | undefined) => {
            const options =
              retryLimit === undefined ? undefined : { retryLimit }
            return delayed
              ? queue.enqueueWithDelay("admission", {}, Duration.zero, options)
              : queue.enqueue("admission", {}, options)
          }
          for (const retryLimit of [
            -1,
            0.5,
            NaN,
            Infinity,
            -Infinity,
            Number.MAX_SAFE_INTEGER,
            Number.MAX_SAFE_INTEGER + 1,
          ]) {
            const result = yield* enqueue(retryLimit).pipe(Effect.result)
            expect(Result.isFailure(result)).toBe(true)
            if (Result.isFailure(result)) {
              expect(result.failure).toBeInstanceOf(EnqueueError)
              expect(result.failure.message).toContain("retryLimit")
            }
          }
          expect(yield* sql`SELECT id FROM pf_job_queue`).toEqual([])
          for (const [retryLimit, expected] of [
            [undefined, 5],
            [0, 1],
            [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER],
          ] as const) {
            const id = yield* enqueue(retryLimit)
            const job = yield* queue.rawClaim("admission")
            expect(Option.isSome(job)).toBe(true)
            if (Option.isSome(job)) {
              expect(job.value.jobId).toBe(id)
              expect(job.value.maxAttempts).toBe(expected)
              expect(job.value.attempts).toBe(1)
              if (retryLimit === 0) {
                yield* queue.fail(id, job.value.receipt, {
                  releaseImmediately: true,
                })
                expect(Option.isNone(yield* queue.rawClaim("admission"))).toBe(
                  true,
                )
              }
              yield* sql`DELETE FROM pf_job_queue WHERE id = ${id}`
            }
          }
        }
      }),
    )
  })

  it("rejects invalid delays and keeps persisted delayed work ineligible until its scheduled time on Turso", async () => {
    await runTest(
      Effect.gen(function* () {
        const queue = yield* QueueService
        const sql = yield* SqlClient.SqlClient
        for (const delay of [
          Duration.millis(-1),
          Duration.infinity,
          Duration.millis(-Infinity),
        ]) {
          const result = yield* queue
            .enqueueWithDelay("delayed-admission", {}, delay)
            .pipe(Effect.result)
          expect(Result.isFailure(result)).toBe(true)
          if (Result.isFailure(result)) {
            expect(result.failure).toBeInstanceOf(EnqueueError)
            expect(result.failure.message).toContain("delay")
          }
        }
        expect(yield* sql`SELECT id FROM pf_job_queue`).toEqual([])
        const id = yield* queue.enqueueWithDelay(
          "delayed-admission",
          {},
          Duration.hours(1),
        )
        expect(yield* sql`SELECT id FROM pf_job_queue`).toEqual([{ id }])
        yield* TestClock.setTime(Date.now())
        expect(Option.isNone(yield* queue.rawClaim("delayed-admission"))).toBe(
          true,
        )
        yield* TestClock.adjust(Duration.hours(2))
        const claimed = yield* queue.rawClaim("delayed-admission")
        expect(Option.isSome(claimed)).toBe(true)
        if (Option.isSome(claimed)) expect(claimed.value.jobId).toBe(id)
      }).pipe(Effect.provide(TestClock.layer())),
    )
  })

  for (const delayed of [false, true]) {
    it(`reports only outermost committed acceptance through the queue interface (delayed=${delayed})`, async () => {
      const logs: Array<ReadonlyArray<unknown>> = []
      const logger = Logger.make((entry) => {
        if (Array.isArray(entry.message)) logs.push(entry.message)
      })
      const accepted = () =>
        logs.filter((entry) => entry[0] === "Queue enqueue accepted")
      const staged = () =>
        logs.filter(
          (entry) =>
            entry[0] ===
            "Queue enqueue staged (provisional until outer commit)",
        )
      const kept: string[] = []
      const rolledBack: string[] = []
      await runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const sql = yield* SqlClient.SqlClient
          yield* sql`CREATE TABLE business_state (job_id TEXT NOT NULL)`
          const produce = Effect.gen(function* () {
            const id = yield* delayed
              ? queue.enqueueWithDelay(
                  "acceptance",
                  { task: "follow-up" },
                  Duration.zero,
                )
              : queue.enqueue("acceptance", { task: "follow-up" })
            yield* sql`INSERT INTO business_state (job_id) VALUES (${id})`
            return id
          })
          kept.push(yield* produce)
          expect(accepted()).toHaveLength(1)
          expect(staged()).toHaveLength(0)

          yield* sql.withTransaction(
            Effect.gen(function* () {
              kept.push(yield* produce)
              expect(staged()).toHaveLength(1)
              yield* sql.withTransaction(
                Effect.gen(function* () {
                  kept.push(yield* produce)
                  expect(staged()).toHaveLength(2)
                  expect(accepted()).toHaveLength(1)
                }),
              )
              expect(accepted()).toHaveLength(1)
              // A caught inner rollback must not be announced by the outer commit.
              yield* sql
                .withTransaction(
                  Effect.gen(function* () {
                    rolledBack.push(yield* produce)
                    return yield* Effect.fail("inner rollback")
                  }),
                )
                .pipe(Effect.catch(() => Effect.void))
            }),
          )
          expect(accepted()).toHaveLength(3)

          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                rolledBack.push(yield* produce)
                yield* sql.withTransaction(
                  Effect.gen(function* () {
                    rolledBack.push(yield* produce)
                  }),
                )
                expect(accepted()).toHaveLength(3)
                return yield* Effect.fail("later outer rollback")
              }),
            )
            .pipe(Effect.catch(() => Effect.void))
          expect(staged()).toHaveLength(5)
          expect(accepted().map((entry) => entry[1])).toEqual(
            kept.map((jobId) => ({
              queue: "acceptance",
              jobId,
              acceptance: "accepted",
            })),
          )
          expect(
            yield* sql`SELECT job_id FROM business_state ORDER BY job_id`,
          ).toEqual(kept.toSorted().map((job_id) => ({ job_id })))
          // A lost response after commit must not delete accepted work.
          const response = yield* sql.withTransaction(produce).pipe(
            Effect.flatMap((id) => {
              kept.push(id)
              return Effect.fail("response lost after commit")
            }),
            Effect.result,
          )
          expect(Result.isFailure(response)).toBe(true)
          expect(accepted()).toHaveLength(4)
          for (const id of rolledBack) {
            expect(
              yield* sql`SELECT id FROM pf_job_queue WHERE id = ${id}`,
            ).toEqual([])
          }
        }).pipe(Effect.provide(Logger.layer([logger]))),
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          // Reopen the real file after producer/queue/database layer release.
          expect(yield* sql`SELECT id FROM pf_job_queue ORDER BY id`).toEqual(
            kept.toSorted().map((id) => ({ id })),
          )
          expect(
            yield* sql`SELECT job_id FROM business_state ORDER BY job_id`,
          ).toEqual(kept.toSorted().map((job_id) => ({ job_id })))
        }),
      )
    })
  }

  it("does not announce insert or deferred COMMIT failures, and permits immediate consumption", () => {
    const logs: Array<ReadonlyArray<unknown>> = []
    const logger = Logger.make((entry) => {
      if (
        Array.isArray(entry.message) &&
        entry.message[0] === "Queue enqueue accepted"
      )
        logs.push(entry.message)
    })
    return runTest(
      Effect.gen(function* () {
        const queue = yield* QueueService
        const sql = yield* SqlClient.SqlClient
        yield* sql`CREATE TRIGGER reject_enqueue BEFORE INSERT ON pf_job_queue
        WHEN NEW.queue = 'reject' BEGIN SELECT RAISE(ABORT, 'insert rejected'); END`
        expect(
          Result.isFailure(
            yield* queue.enqueue("reject", {}).pipe(Effect.result),
          ),
        ).toBe(true)
        expect(logs).toEqual([])
        yield* sql`CREATE TABLE parent (id TEXT PRIMARY KEY)`
        yield* sql`CREATE TABLE child (id TEXT REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)`
        const commit = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO child (id) VALUES ('missing-parent')`
              yield* queue.enqueue("commit-failure", {})
            }),
          )
          .pipe(Effect.result)
        expect(Result.isFailure(commit)).toBe(true)
        expect(logs).toHaveLength(0)
        expect(yield* sql`SELECT id FROM pf_job_queue`).toEqual([])
        // Consume before the producing caller inspects its return value.
        const id = yield* queue.enqueue("fast-worker", {}).pipe(
          Effect.tap(() =>
            Effect.gen(function* () {
              const job = yield* queue.rawClaim("fast-worker")
              expect(Option.isSome(job)).toBe(true)
              if (Option.isSome(job))
                yield* queue.acknowledge(job.value.jobId, job.value.receipt)
            }),
          ),
        )
        expect(logs.map((entry) => entry[1])).toEqual([
          { queue: "fast-worker", jobId: id, acceptance: "accepted" },
        ])
        expect(yield* sql`SELECT id FROM pf_job_queue`).toEqual([])
      }).pipe(Effect.provide(Logger.layer([logger]))),
    )
  })

  for (const { name, run } of batchQueueCases) {
    it(name, () => runTest(run))
  }

  for (const size of [100, 1001]) {
    it(`acknowledges ${size} claims with bounded binds and returns only deleted IDs`, () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const sql = yield* SqlClient.SqlClient
          const ids = Array.from({ length: size }, (_, i) => `large-ack-${i}`)
          // This checks claim/ack batching, not producer admission. Seed real
          // rows in bounded batches instead of paying for 1001 autocommits.
          for (let offset = 0; offset < size; offset += 100) {
            const [first, ...rest] = ids.slice(offset, offset + 100)
            if (first === undefined) throw new Error("Empty seed batch")
            const row = (id: string) => ({
              id,
              queue: "large-ack",
              job_payload: "{}",
            })
            yield* sql`INSERT INTO pf_job_queue ${sql.insert([row(first), ...rest.map(row)])}`
          }
          const jobs = yield* queue.rawClaimBatch("large-ack", size)
          expect(jobs).toHaveLength(size)

          const bindCounts: number[] = []
          const deleted = yield* queue.acknowledgeBatch(jobs).pipe(
            Effect.provideService(Statement.CurrentTransformer, (statement) =>
              Effect.sync(() => {
                bindCounts.push(statement.compile()[1].length)
                return statement
              }),
            ),
          )
          expect(deleted.toSorted()).toEqual(ids.toSorted())
          expect(yield* sql`SELECT id FROM pf_job_queue`).toEqual([])
          expect(bindCounts.length).toBeGreaterThan(0)
          expect(bindCounts.every((count) => count <= 999)).toBe(true)
        }),
      ))
  }
})
