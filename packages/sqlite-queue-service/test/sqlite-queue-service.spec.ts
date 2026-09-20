import {
  DateTime,
  Duration,
  Effect,
  Either,
  FiberRef,
  Layer,
  Option,
} from "effect"
import { UserDetails, type UserDetailsValue } from "@pf/graphql-db-operations"
import {
  InvalidQueueNameError,
  QueueService,
  StaleJobClaimError,
} from "@pf/queue-service"
import { RequestTime } from "@pf/request-time"
import { DatabaseTest } from "@pf/service-drizzle-sqlite/test"
import { SqliteQueueServiceLive } from "../src/lib/sqlite-queue-service"
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

  type TestRequirements = Layer.Layer.Success<typeof TestLayer>

  const runTest = <A, E>(
    test: Effect.Effect<A, E, TestRequirements>,
  ): Promise<A> => {
    return Effect.runPromise(Effect.provide(test, TestLayer))
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

          const result = yield* Effect.either(
            queue.acknowledge("non-existent-id", "non-existent-receipt"),
          )

          expect(result._tag).toBe("Left")
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
            const result = yield* Effect.either(operation)
            Either.match(result, {
              onLeft: (error) =>
                expect(error).toBeInstanceOf(StaleJobClaimError),
              onRight: () => {
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

          const result = yield* Effect.either(
            queue.extendVisibility(
              "non-existent-id",
              "non-existent-receipt",
              Duration.seconds(10),
            ),
          )

          expect(result._tag).toBe("Left")
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
          expect(Option.isSome(claimed)).toBe(true) // Verify claim succeeded

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

          const stats = yield* queue.getStats(queueName)

          expect(stats.deadLetter).toBe(1)
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
          const result = yield* Effect.either(
            queue.enqueue("invalid queue", { task: "test" }),
          )

          expect(result._tag).toBe("Left")
          if (result._tag === "Left") {
            expect(result.left).toBeInstanceOf(InvalidQueueNameError)
            expect(result.left.message).toContain("invalid characters")
          }
        }),
      ))

    it("should reject enqueue with invalid queue name (special chars)", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const result = yield* Effect.either(
            queue.enqueue("invalid@queue", { task: "test" }),
          )

          expect(result._tag).toBe("Left")
          if (result._tag === "Left") {
            expect(result.left).toBeInstanceOf(InvalidQueueNameError)
          }
        }),
      ))

    it("should reject enqueue with empty queue name", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const result = yield* Effect.either(
            queue.enqueue("", { task: "test" }),
          )

          expect(result._tag).toBe("Left")
          if (result._tag === "Left") {
            expect(result.left).toBeInstanceOf(InvalidQueueNameError)
            expect(result.left.message).toContain("cannot be empty")
          }
        }),
      ))

    it("should reject enqueue with queue name exceeding max length", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const longName = "a".repeat(81)
          const result = yield* Effect.either(
            queue.enqueue(longName, { task: "test" }),
          )

          expect(result._tag).toBe("Left")
          if (result._tag === "Left") {
            expect(result.left).toBeInstanceOf(InvalidQueueNameError)
            expect(result.left.message).toContain("exceeds maximum length")
          }
        }),
      ))

    it("should reject enqueueWithDelay with invalid queue name", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const result = yield* Effect.either(
            queue.enqueueWithDelay(
              "invalid queue",
              { task: "test" },
              Duration.seconds(1),
            ),
          )

          expect(result._tag).toBe("Left")
          if (result._tag === "Left") {
            expect(result.left).toBeInstanceOf(InvalidQueueNameError)
          }
        }),
      ))

    it("should reject claim with invalid queue name", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const result = yield* Effect.either(queue.rawClaim("invalid@queue"))

          expect(result._tag).toBe("Left")
          if (result._tag === "Left") {
            expect(result.left).toBeInstanceOf(InvalidQueueNameError)
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
          const result = yield* Effect.either(queue.getStats("invalid queue"))

          expect(result._tag).toBe("Left")
          if (result._tag === "Left") {
            expect(result.left).toBeInstanceOf(InvalidQueueNameError)
          }
        }),
      ))
  })
})
