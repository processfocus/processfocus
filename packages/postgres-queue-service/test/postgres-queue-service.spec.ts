import { expect, it } from "@effect/vitest"
import {
  Clock,
  DateTime,
  Duration,
  Effect,
  Either,
  FiberRef,
  Layer,
  Option,
} from "effect"
import { UserDetails, type UserDetailsValue } from "@pf/graphql-db-operations"
import { PostgresQueueServiceLive } from "@pf/postgres-queue-service"
import {
  InvalidQueueNameError,
  QueueService,
  StaleJobClaimError,
} from "@pf/queue-service"
import { RequestTime } from "@pf/request-time"
import { PostgresTest } from "@pf/service-drizzle-postgres/test"

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

// Provide a real Clock because @effect/vitest uses TestClock by default,
// which starts at epoch 0 and breaks DateTime.now comparisons
const RealClockLive = Layer.setClock(Clock.make())

const QueueTest = PostgresQueueServiceLive.pipe(
  Layer.provideMerge(
    Layer.mergeAll(RequestTimeLive, UserDetailsLive, PostgresTest),
  ),
)

const TestLayer = Layer.mergeAll(
  QueueTest,
  RequestTimeLive,
  UserDetailsLive,
  PostgresTest,
  RealClockLive,
)

it.layer(TestLayer, { timeout: "60 seconds" })("PostgresQueueService", (it) => {
  // NOTE: All tests in this block share a single PostgreSQL container instance
  // Tests run concurrently (vitest default: max 5 at once)
  // Use unique queue names to avoid conflicts between tests
  //
  // PostgreSQL statement_timeout is set to 5 seconds in the test container
  // to prevent tests from hanging on locks (see postgres-alpine-container.ts)

  it.effect("enqueue - should enqueue a job and return job ID", () =>
    Effect.gen(function* () {
      const queue = yield* QueueService

      const jobId = yield* queue.enqueue("test-enqueue-queue", { task: "test" })

      expect(jobId).toBeDefined()
      expect(typeof jobId).toBe("string")
      expect(jobId.length).toBeGreaterThan(0)
    }),
  )

  it.effect("enqueue - should enqueue jobs with different payloads", () =>
    Effect.gen(function* () {
      const queue = yield* QueueService

      const jobId1 = yield* queue.enqueue("test-multi-enqueue", {
        task: "task1",
      })
      const jobId2 = yield* queue.enqueue("test-multi-enqueue", {
        task: "task2",
      })

      expect(jobId1).not.toBe(jobId2)
    }),
  )

  it.effect("enqueue - keeps logical job IDs separate from physical IDs", () =>
    Effect.gen(function* () {
      const queue = yield* QueueService
      const logicalJobId = `execution-event:restart:${"x".repeat(80)}`

      const firstId = yield* queue.enqueue(
        "logical-id-queue-pg",
        { task: "first" },
        { logicalJobId },
      )
      const secondId = yield* queue.enqueue(
        "logical-id-queue-pg",
        { task: "second" },
        { logicalJobId },
      )
      const firstDelayedId = yield* queue.enqueueWithDelay(
        "logical-id-delay-queue-pg",
        { task: "first-delayed" },
        Duration.seconds(1),
        { logicalJobId },
      )
      const secondDelayedId = yield* queue.enqueueWithDelay(
        "logical-id-delay-queue-pg",
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
  )

  it.effect("enqueue - should enqueue and claim a job", () =>
    Effect.gen(function* () {
      const queue = yield* QueueService

      yield* queue.enqueue("retry-queue-pg", { task: "test" })

      // Claim the job
      const job = yield* queue.rawClaim("retry-queue-pg")
      expect(Option.isSome(job)).toBe(true)
      if (Option.isSome(job)) {
        expect(job.value.attempts).toBe(1)
      }
    }),
  )

  it.effect("enqueueWithDelay - should enqueue a job with delay", () =>
    Effect.gen(function* () {
      const queue = yield* QueueService

      const jobId = yield* queue.enqueueWithDelay(
        "delayed-queue-pg",
        { task: "delayed" },
        Duration.seconds(60),
      )

      expect(jobId).toBeDefined()

      // Job should not be claimable immediately
      const job = yield* queue.rawClaim("delayed-queue-pg")
      expect(Option.isNone(job)).toBe(true)
    }),
  )

  it.effect("claim - should claim an available job", () =>
    Effect.gen(function* () {
      const queue = yield* QueueService
      const queueName = `claim-queue-${Date.now()}`

      const jobId = yield* queue.enqueue(queueName, {
        task: "to-claim",
      })
      const job = yield* queue.rawClaim(queueName)

      expect(Option.isSome(job)).toBe(true)
      if (Option.isSome(job)) {
        expect(job.value.jobId).toBe(jobId)
        expect(job.value.payload).toEqual({ task: "to-claim" })
        expect(job.value.attempts).toBe(1)
      }
    }),
  )

  it.effect("claim - should return None when no jobs available", () =>
    Effect.gen(function* () {
      const queue = yield* QueueService

      const job = yield* queue.rawClaim("empty-queue-pg")

      expect(Option.isNone(job)).toBe(true)
    }),
  )

  it.effect("claim - should not claim already claimed job", () =>
    Effect.gen(function* () {
      const queue = yield* QueueService
      const queueName = `single-claim-queue-${Date.now()}`

      yield* queue.enqueue(queueName, { task: "test" })

      const job1 = yield* queue.rawClaim(queueName)
      const job2 = yield* queue.rawClaim(queueName)

      expect(Option.isSome(job1)).toBe(true)
      expect(Option.isNone(job2)).toBe(true)
    }),
  )

  it.effect("claim - should increment attempts on each claim", () =>
    Effect.gen(function* () {
      const queue = yield* QueueService
      const queueName = `attempts-queue-${Date.now()}`

      yield* queue.enqueue(queueName, { task: "test" })

      // First claim
      const job1 = yield* queue.rawClaim(queueName)
      expect(Option.isSome(job1)).toBe(true)
      if (Option.isSome(job1)) {
        expect(job1.value.attempts).toBe(1)
        // Release immediately for re-claim
        yield* queue.fail(job1.value.jobId, job1.value.receipt, {
          releaseImmediately: true,
        })
      }

      // Second claim after release
      const job2 = yield* queue.rawClaim(queueName)
      expect(Option.isSome(job2)).toBe(true)
      if (Option.isSome(job2)) {
        expect(job2.value.attempts).toBe(2)
      }
    }),
  )

  it.effect("claim - should replace the receipt on every claim", () =>
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
  )

  it.effect("claim - should prefer fresh jobs over retried jobs", () =>
    Effect.gen(function* () {
      const queue = yield* QueueService
      const queueName = `retry-order-queue-${Date.now()}`

      yield* queue.enqueue(queueName, { task: "retried" })

      const firstClaim = yield* queue.rawClaim(queueName, Duration.seconds(60))
      expect(Option.isSome(firstClaim)).toBe(true)
      if (Option.isSome(firstClaim)) {
        yield* queue.fail(firstClaim.value.jobId, firstClaim.value.receipt, {
          releaseImmediately: true,
        })
      }

      yield* queue.enqueue(queueName, { task: "fresh" })

      const nextClaim = yield* queue.rawClaim(queueName, Duration.seconds(60))
      expect(Option.isSome(nextClaim)).toBe(true)
      if (Option.isSome(nextClaim)) {
        expect(nextClaim.value.payload).toEqual({ task: "fresh" })
        expect(nextClaim.value.attempts).toBe(1)
      }
    }),
  )

  it.effect("claim - should not claim jobs that exceeded max retries", () =>
    Effect.gen(function* () {
      const queue = yield* QueueService
      const queueName = `max-retry-queue-${Date.now()}`

      yield* queue.enqueue(queueName, { task: "test" })

      // Claim 5 times (default maxRetries = 5, exhaust retries) using releaseImmediately
      for (let i = 0; i < 5; i++) {
        const job = yield* queue.rawClaim(queueName)
        expect(Option.isSome(job)).toBe(true)
        if (Option.isSome(job)) {
          yield* queue.fail(job.value.jobId, job.value.receipt, {
            releaseImmediately: true,
          })
        }
      }

      // Sixth claim should fail (max retries = 5)
      const job6 = yield* queue.rawClaim(queueName)
      expect(Option.isNone(job6)).toBe(true)
    }),
  )

  it.effect("acknowledge - should acknowledge and remove job from queue", () =>
    Effect.gen(function* () {
      const queue = yield* QueueService
      const queueName = `ack-queue-${Date.now()}`

      yield* queue.enqueue(queueName, { task: "test" })
      const claimed = yield* queue.rawClaim(queueName)
      if (Option.isNone(claimed)) return
      yield* queue.acknowledge(claimed.value.jobId, claimed.value.receipt)

      // Job should no longer be claimable
      const job = yield* queue.rawClaim(queueName)
      expect(Option.isNone(job)).toBe(true)
    }),
  )

  it.effect("acknowledge - should fail for non-existent job", () =>
    Effect.gen(function* () {
      const queue = yield* QueueService

      const result = yield* Effect.either(
        queue.acknowledge("non-existent-id", "non-existent-receipt"),
      )

      expect(result._tag).toBe("Left")
    }),
  )

  it.effect("fail - should mark job as failed but keep it for retry", () =>
    Effect.gen(function* () {
      const queue = yield* QueueService
      const queueName = `fail-queue-${Date.now()}`

      yield* queue.enqueue(queueName, { task: "test" })
      const job = yield* queue.rawClaim(queueName, Duration.seconds(60))

      expect(Option.isSome(job)).toBe(true)
      if (Option.isSome(job)) {
        yield* queue.fail(job.value.jobId, job.value.receipt)

        // Job should not be immediately claimable (still locked)
        const job2 = yield* queue.rawClaim(queueName)
        expect(Option.isNone(job2)).toBe(true)
      }
    }),
  )

  it.effect(
    "fail - should release job immediately with releaseImmediately option",
    () =>
      Effect.gen(function* () {
        const queue = yield* QueueService
        const queueName = `fail-immediate-queue-${Date.now()}`

        yield* queue.enqueue(queueName, { task: "test" })
        const job = yield* queue.rawClaim(queueName, Duration.seconds(60))

        expect(Option.isSome(job)).toBe(true)
        if (Option.isSome(job)) {
          yield* queue.fail(job.value.jobId, job.value.receipt, {
            releaseImmediately: true,
          })

          // Job should be immediately claimable
          const job2 = yield* queue.rawClaim(queueName)
          expect(Option.isSome(job2)).toBe(true)
          if (Option.isSome(job2)) {
            expect(job2.value.attempts).toBe(2)
          }
        }
      }),
  )

  it.effect("fail - should move a current claim directly to dead letter", () =>
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
  )

  it.effect(
    "stale claims - should reject every stale operation without changing the current lease",
    () =>
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
            onLeft: (error) => expect(error).toBeInstanceOf(StaleJobClaimError),
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
        const reclaimed = yield* queue.rawClaim(queueName, Duration.seconds(1))
        expect(Option.isSome(reclaimed)).toBe(true)
        if (Option.isSome(reclaimed)) {
          yield* queue.acknowledge(
            reclaimed.value.jobId,
            reclaimed.value.receipt,
          )
        }
      }),
  )

  it.effect(
    "extendVisibility - should set new visibility timeout from now",
    () =>
      Effect.gen(function* () {
        const queue = yield* QueueService
        const queueName = `extend-queue-${Date.now()}`

        yield* queue.enqueue(queueName, { task: "test" })
        // Use longer visibility timeout to avoid needing Effect.sleep
        const job = yield* queue.rawClaim(queueName, Duration.seconds(60))

        expect(Option.isSome(job)).toBe(true)
        if (Option.isSome(job)) {
          // Set visibility timeout to 10 seconds from now (SQS semantics)
          yield* queue.extendVisibility(
            job.value.jobId,
            job.value.receipt,
            Duration.seconds(10),
          )

          // Job should still not be claimable (locked for 10 seconds from now)
          const job2 = yield* queue.rawClaim(queueName)
          expect(Option.isNone(job2)).toBe(true)
        }
      }),
  )

  it.effect("extendVisibility - should fail for non-existent job", () =>
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
  )

  it.effect("getStats - should return queue statistics", () =>
    Effect.gen(function* () {
      const queue = yield* QueueService
      const queueName = `stats-queue-${Date.now()}`

      // Enqueue some jobs
      yield* queue.enqueue(queueName, { task: "pending1" })
      yield* queue.enqueue(queueName, { task: "pending2" })

      // Claim one to make it processing
      yield* queue.rawClaim(queueName, Duration.seconds(60))

      const stats = yield* queue.getStats(queueName)

      expect(stats.pending).toBe(1)
      expect(stats.processing).toBe(1)
      expect(stats.deadLetter).toBe(0)
    }),
  )

  it.effect("getStats - should count dead letter jobs", () =>
    Effect.gen(function* () {
      const queue = yield* QueueService
      const queueName = `dead-letter-queue-${Date.now()}`

      // Create a job with default maxRetries (5)
      yield* queue.enqueue(queueName, { task: "test" })

      // Claim it 5 times (exhausts retries)
      for (let i = 0; i < 5; i++) {
        const job = yield* queue.rawClaim(queueName)
        expect(Option.isSome(job)).toBe(true)
        if (Option.isSome(job)) {
          yield* queue.fail(job.value.jobId, job.value.receipt, {
            releaseImmediately: true,
          })
        }
      }

      const stats = yield* queue.getStats(queueName)

      // After 5 claims with maxRetries=5, the job has exhausted retries and is dead letter
      expect(stats.deadLetter).toBe(1)
    }),
  )

  it.effect("concurrency - should handle concurrent enqueue operations", () =>
    Effect.gen(function* () {
      const queue = yield* QueueService
      const queueName = `concurrent-enqueue-${Date.now()}`

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
    }),
  )

  it.effect(
    "concurrency - should not double-claim jobs under concurrent claim attempts (FOR UPDATE SKIP LOCKED)",
    () =>
      Effect.gen(function* () {
        const queue = yield* QueueService
        const queueName = `concurrent-claim-${Date.now()}`

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
  )

  it.effect(
    "concurrency - should handle high concurrency claim without duplicate claims",
    () =>
      Effect.gen(function* () {
        const queue = yield* QueueService
        const queueName = `high-concurrency-${Date.now()}`

        // Enqueue 20 jobs
        yield* Effect.all(
          Array.from({ length: 20 }, (_, i) =>
            queue.enqueue(queueName, { task: `task-${i}` }),
          ),
          { concurrency: "unbounded" },
        )

        // Try to claim 50 times concurrently (more than available)
        const results = yield* Effect.all(
          Array.from({ length: 50 }, () =>
            queue.rawClaim(queueName, Duration.seconds(60)),
          ),
          { concurrency: "unbounded" },
        )

        // Exactly 20 should succeed (no more, no less)
        const successfulClaims = results.filter(Option.isSome)
        expect(successfulClaims.length).toBe(20)

        // All claimed jobs should be unique (no double-claims)
        const claimedIds = successfulClaims.map((job) => job.value.jobId)
        const uniqueClaimedIds = new Set(claimedIds)
        expect(uniqueClaimedIds.size).toBe(20)
      }),
  )

  it.effect(
    "queue name validation - should reject enqueue with invalid queue name (spaces)",
    () =>
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
  )

  it.effect(
    "queue name validation - should reject enqueue with invalid queue name (special chars)",
    () =>
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
  )

  it.effect(
    "queue name validation - should reject enqueue with empty queue name",
    () =>
      Effect.gen(function* () {
        const queue = yield* QueueService
        const result = yield* Effect.either(queue.enqueue("", { task: "test" }))

        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          expect(result.left).toBeInstanceOf(InvalidQueueNameError)
          expect(result.left.message).toContain("cannot be empty")
        }
      }),
  )

  it.effect(
    "queue name validation - should reject enqueue with queue name exceeding max length",
    () =>
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
  )

  it.effect(
    "queue name validation - should reject enqueueWithDelay with invalid queue name",
    () =>
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
  )

  it.effect(
    "queue name validation - should reject claim with invalid queue name",
    () =>
      Effect.gen(function* () {
        const queue = yield* QueueService
        const result = yield* Effect.either(queue.rawClaim("invalid@queue"))

        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          expect(result.left).toBeInstanceOf(InvalidQueueNameError)
        }
      }),
  )

  it.effect("queue name validation - should accept valid queue names", () =>
    Effect.gen(function* () {
      const queue = yield* QueueService
      const validNames = [
        "test-queue-valid-1",
        "test_queue_valid_2",
        "test.queue.valid.3",
        "TestQueueValid123",
        "a-valid-name",
      ]

      for (const name of validNames) {
        const jobId = yield* queue.enqueue(name, { task: "test" })
        expect(jobId).toBeDefined()
      }
    }),
  )

  it.effect(
    "queue name validation - should reject getStats with invalid queue name",
    () =>
      Effect.gen(function* () {
        const queue = yield* QueueService
        const result = yield* Effect.either(queue.getStats("invalid queue"))

        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          expect(result.left).toBeInstanceOf(InvalidQueueNameError)
        }
      }),
  )
})
