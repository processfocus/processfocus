import type { SqlError } from "@effect/sql/SqlError"
import {
  AcknowledgeError,
  ClaimError,
  DEFAULT_MAX_RETRIES,
  DEFAULT_VISIBILITY_TIMEOUT,
  EnqueueError,
  JobNotFoundError,
  type Payload,
  QueueService,
  type QueueServiceShape,
  type RawJob,
  StaleJobClaimError,
  closeQueue,
  validateQueueName,
} from "@processfocus/runtime"
import { and, eq, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm"
import { Cause, DateTime, Duration, Effect, Layer, Option } from "effect"
import * as schema from "@pf/drizzle-postgres"
import {
  type UserDetails,
  getUserDetails,
  returnedRow,
} from "@pf/graphql-db-operations"
import { formatSqlError } from "@pf/queue-service"
import { type RequestTime, getRequestTime } from "@pf/request-time"
import { TypedPostgresDrizzle } from "@pf/service-drizzle-postgres"

const mapClaimVerificationError = (jobId: string) =>
  Effect.mapError(
    (error: SqlError) =>
      new AcknowledgeError({
        jobId,
        message: `Failed to verify job claim: ${formatSqlError(error)}`,
        cause: error,
      }),
  )

/**
 * PostgreSQL implementation of the QueueService.
 *
 * Uses FOR UPDATE SKIP LOCKED for efficient concurrent claiming.
 * All operations require TypedPostgresDrizzle.
 */
type PostgresQueueRequirements =
  | RequestTime
  | TypedPostgresDrizzle
  | UserDetails

export const PostgresQueueServiceLive = Layer.effect(
  QueueService,
  Effect.gen(function* () {
    const context = yield* Effect.context<PostgresQueueRequirements>()
    const queue: QueueServiceShape<PostgresQueueRequirements> = {
      queueInTransaction: true,

      enqueue: <P extends Payload>(
        queue: string,
        payload: P,
        options?: {
          readonly retryLimit?: number
          readonly logicalJobId?: string
        },
      ) =>
        Effect.gen(function* () {
          yield* validateQueueName(queue)
          const db = yield* TypedPostgresDrizzle
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()

          const result = yield* db
            .insert(schema.jobQueue)
            .values({
              queue,
              jobPayload: payload as Record<string, unknown>,
              jobRetryLimit:
                options?.retryLimit !== undefined
                  ? options.retryLimit + 1
                  : DEFAULT_MAX_RETRIES,
              availableAt: requestTime,
              lockedUntil: null,
              createdAt: requestTime,
              updatedAt: requestTime,
              createdBy: userDetails.by,
              updatedBy: userDetails.by,
            })
            .returning({ id: schema.jobQueue.id })
            .pipe(
              Effect.catchTag("SqlError", (error: SqlError) => {
                const formattedMsg = formatSqlError(error)
                console.error(
                  `[PostgresQueueService] enqueue failed for queue=${queue}:`,
                  formattedMsg,
                  error,
                )
                return Effect.fail(
                  new EnqueueError({
                    queue,
                    message: `Database error: ${formattedMsg}`,
                    cause: error,
                  }),
                )
              }),
            )

          const row = yield* returnedRow(result)
          return row.id
        }),

      enqueueWithDelay: <P extends Payload>(
        queue: string,
        payload: P,
        delay: Duration.Duration,
        options?: {
          readonly retryLimit?: number
          readonly logicalJobId?: string
        },
      ) =>
        Effect.gen(function* () {
          yield* validateQueueName(queue)
          const db = yield* TypedPostgresDrizzle
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()
          const delayMs = Duration.toMillis(delay)
          const availableAt = DateTime.add(requestTime, { millis: delayMs })

          const result = yield* db
            .insert(schema.jobQueue)
            .values({
              queue,
              jobPayload: payload as Record<string, unknown>,
              jobRetryLimit:
                options?.retryLimit !== undefined
                  ? options.retryLimit + 1
                  : DEFAULT_MAX_RETRIES,
              availableAt,
              lockedUntil: null,
              createdAt: requestTime,
              updatedAt: requestTime,
              createdBy: userDetails.by,
              updatedBy: userDetails.by,
            })
            .returning({ id: schema.jobQueue.id })
            .pipe(
              Effect.catchTag("SqlError", (error: SqlError) => {
                const formattedMsg = formatSqlError(error)
                console.error(
                  `[PostgresQueueService] enqueueWithDelay failed for queue=${queue}:`,
                  formattedMsg,
                  error,
                )
                return Effect.fail(
                  new EnqueueError({
                    queue,
                    message: `Database error: ${formattedMsg}`,
                    cause: error,
                  }),
                )
              }),
            )

          const row = yield* returnedRow(result)
          return row.id
        }),

      rawClaim: (queue: string, visibilityTimeout?: Duration.Duration) =>
        Effect.gen(function* () {
          yield* validateQueueName(queue)
          const db = yield* TypedPostgresDrizzle
          const now = yield* DateTime.now
          const timeout = visibilityTimeout ?? DEFAULT_VISIBILITY_TIMEOUT
          const timeoutMs = Duration.toMillis(timeout)
          const lockedUntil = DateTime.add(now, { millis: timeoutMs })
          const receipt = crypto.randomUUID()

          // Use CTE with FOR UPDATE SKIP LOCKED for efficient concurrent claiming
          // Use drizzle query builder functions so custom type converters are applied
          const candidate = db.$with("candidate").as(
            db
              .select({ id: schema.jobQueue.id })
              .from(schema.jobQueue)
              .where(
                and(
                  eq(schema.jobQueue.queue, queue),
                  lte(schema.jobQueue.availableAt, now),
                  or(
                    isNull(schema.jobQueue.lockedUntil),
                    lte(schema.jobQueue.lockedUntil, now),
                  ),
                  lt(
                    schema.jobQueue.jobAttempts,
                    schema.jobQueue.jobRetryLimit,
                  ),
                  eq(schema.jobQueue._deleted, false),
                ),
              )
              .orderBy(
                schema.jobQueue.jobAttempts,
                schema.jobQueue.availableAt,
                schema.jobQueue.id,
              )
              .limit(1)
              .for("update", { skipLocked: true }),
          )

          const result = yield* db
            .with(candidate)
            .update(schema.jobQueue)
            .set({
              lockedUntil,
              claimReceipt: receipt,
              jobAttempts: sql`${schema.jobQueue.jobAttempts} + 1`,
            })
            .where(sql`${schema.jobQueue.id} IN (SELECT id FROM candidate)`)
            .returning({
              id: schema.jobQueue.id,
              queue: schema.jobQueue.queue,
              jobPayload: schema.jobQueue.jobPayload,
              jobAttempts: schema.jobQueue.jobAttempts,
              jobRetryLimit: schema.jobQueue.jobRetryLimit,
              availableAt: schema.jobQueue.availableAt,
              lockedUntil: schema.jobQueue.lockedUntil,
            })
            .pipe(
              Effect.catchTag("SqlError", (error: SqlError) => {
                const formattedMsg = formatSqlError(error)
                console.error(
                  `[PostgresQueueService] rawClaim failed for queue=${queue}:`,
                  formattedMsg,
                  error,
                )
                return Effect.fail(
                  new ClaimError({
                    queue,
                    message: `Database error: ${formattedMsg}`,
                    cause: error,
                  }),
                )
              }),
            )

          if (!result[0]) {
            return Option.none()
          }

          const row = result[0]
          return Option.some<RawJob>({
            jobId: row.id,
            receipt,
            queue: row.queue,
            payload: row.jobPayload,
            attempts: row.jobAttempts,
            maxAttempts: row.jobRetryLimit,
            availableAt: row.availableAt,
            lockedUntil: lockedUntil,
          })
        }),

      acknowledge: (jobId: string, receipt: string) =>
        Effect.gen(function* () {
          const db = yield* TypedPostgresDrizzle

          const result = yield* db
            .delete(schema.jobQueue)
            .where(
              and(
                eq(schema.jobQueue.id, jobId),
                eq(schema.jobQueue.claimReceipt, receipt),
              ),
            )
            .returning({ id: schema.jobQueue.id })
            .pipe(
              Effect.catchTag("SqlError", (error: SqlError) => {
                const formattedMsg = formatSqlError(error)
                console.error(
                  `[PostgresQueueService] acknowledge failed for jobId=${jobId}:`,
                  formattedMsg,
                  error,
                )
                return Effect.fail(
                  new AcknowledgeError({
                    jobId,
                    message: `Database error: ${formattedMsg}`,
                    cause: error,
                  }),
                )
              }),
            )

          if (!result[0]) {
            const exists = yield* db
              .select({ id: schema.jobQueue.id })
              .from(schema.jobQueue)
              .where(eq(schema.jobQueue.id, jobId))
              .pipe(mapClaimVerificationError(jobId))
            return yield* exists[0]
              ? new StaleJobClaimError({ jobId })
              : new JobNotFoundError({ jobId })
          }
        }),

      fail: (
        jobId: string,
        receipt: string,
        options?: {
          readonly releaseImmediately?: boolean
          readonly retryable?: boolean
        },
      ) =>
        Effect.gen(function* () {
          const db = yield* TypedPostgresDrizzle

          if (options?.retryable === false) {
            const result = yield* db
              .update(schema.jobQueue)
              .set({
                jobAttempts: sql`${schema.jobQueue.jobRetryLimit}`,
                lockedUntil: null,
                claimReceipt: null,
              })
              .where(
                and(
                  eq(schema.jobQueue.id, jobId),
                  eq(schema.jobQueue.claimReceipt, receipt),
                ),
              )
              .returning({ id: schema.jobQueue.id })
              .pipe(
                Effect.catchTag("SqlError", (error: SqlError) => {
                  const formattedMsg = formatSqlError(error)
                  console.error(
                    `[PostgresQueueService] fail (terminal) failed for jobId=${jobId}:`,
                    formattedMsg,
                    error,
                  )
                  return Effect.fail(
                    new AcknowledgeError({
                      jobId,
                      message: `Failed to dead-letter job: ${formattedMsg}`,
                      cause: error,
                    }),
                  )
                }),
              )

            if (!result[0]) {
              const exists = yield* db
                .select({ id: schema.jobQueue.id })
                .from(schema.jobQueue)
                .where(eq(schema.jobQueue.id, jobId))
                .pipe(mapClaimVerificationError(jobId))
              return yield* exists[0]
                ? new StaleJobClaimError({ jobId })
                : new JobNotFoundError({ jobId })
            }

            return
          }

          if (options?.releaseImmediately) {
            // Set lockedUntil to null to make job immediately available
            const result = yield* db
              .update(schema.jobQueue)
              .set({ lockedUntil: null, claimReceipt: null })
              .where(
                and(
                  eq(schema.jobQueue.id, jobId),
                  eq(schema.jobQueue.claimReceipt, receipt),
                ),
              )
              .returning({ id: schema.jobQueue.id })
              .pipe(
                Effect.catchTag("SqlError", (error: SqlError) => {
                  const formattedMsg = formatSqlError(error)
                  console.error(
                    `[PostgresQueueService] fail (releaseImmediately) failed for jobId=${jobId}:`,
                    formattedMsg,
                    error,
                  )
                  return Effect.fail(
                    new AcknowledgeError({
                      jobId,
                      message: `Failed to mark job as failed: ${formattedMsg}`,
                      cause: error,
                    }),
                  )
                }),
              )

            if (!result[0]) {
              const exists = yield* db
                .select({ id: schema.jobQueue.id })
                .from(schema.jobQueue)
                .where(eq(schema.jobQueue.id, jobId))
                .pipe(mapClaimVerificationError(jobId))
              return yield* exists[0]
                ? new StaleJobClaimError({ jobId })
                : new JobNotFoundError({ jobId })
            }
          } else {
            // Job stays locked until visibility timeout expires (no action needed)
            // Just verify the job exists
            const result = yield* db
              .select({ id: schema.jobQueue.id })
              .from(schema.jobQueue)
              .where(
                and(
                  eq(schema.jobQueue.id, jobId),
                  eq(schema.jobQueue.claimReceipt, receipt),
                ),
              )
              .pipe(
                Effect.catchTag("SqlError", (error: SqlError) => {
                  const formattedMsg = formatSqlError(error)
                  console.error(
                    `[PostgresQueueService] fail (verify) failed for jobId=${jobId}:`,
                    formattedMsg,
                    error,
                  )
                  return Effect.fail(
                    new AcknowledgeError({
                      jobId,
                      message: `Failed to verify job exists: ${formattedMsg}`,
                      cause: error,
                    }),
                  )
                }),
              )

            if (!result[0]) {
              const exists = yield* db
                .select({ id: schema.jobQueue.id })
                .from(schema.jobQueue)
                .where(eq(schema.jobQueue.id, jobId))
                .pipe(mapClaimVerificationError(jobId))
              return yield* exists[0]
                ? new StaleJobClaimError({ jobId })
                : new JobNotFoundError({ jobId })
            }
          }
        }),

      extendVisibility: (
        jobId: string,
        receipt: string,
        timeout: Duration.Duration,
      ) =>
        Effect.gen(function* () {
          const db = yield* TypedPostgresDrizzle
          const now = yield* DateTime.now
          const newLock = DateTime.add(now, {
            millis: Duration.toMillis(timeout),
          })

          // Atomic UPDATE with WHERE clause checking both existence and lock status
          // This prevents race conditions where another worker could acknowledge/delete
          // the job between a SELECT and UPDATE
          const result = yield* db
            .update(schema.jobQueue)
            .set({ lockedUntil: newLock })
            .where(
              and(
                eq(schema.jobQueue.id, jobId),
                eq(schema.jobQueue.claimReceipt, receipt),
                isNotNull(schema.jobQueue.lockedUntil),
              ),
            )
            .returning({ id: schema.jobQueue.id })
            .pipe(
              Effect.catchTag("SqlError", (error: SqlError) => {
                const formattedMsg = formatSqlError(error)
                console.error(
                  `[PostgresQueueService] extendVisibility failed for jobId=${jobId}:`,
                  formattedMsg,
                  error,
                )
                return Effect.fail(
                  new AcknowledgeError({
                    jobId,
                    message: `Failed to extend visibility: ${formattedMsg}`,
                    cause: error,
                  }),
                )
              }),
            )

          if (!result[0]) {
            // Job either doesn't exist or is not locked
            // Check which case to provide better error message
            const exists = yield* db
              .select({
                lockedUntil: schema.jobQueue.lockedUntil,
                claimReceipt: schema.jobQueue.claimReceipt,
              })
              .from(schema.jobQueue)
              .where(eq(schema.jobQueue.id, jobId))
              .pipe(
                Effect.catchTag("SqlError", (error: SqlError) => {
                  const formattedMsg = formatSqlError(error)
                  console.error(
                    `[PostgresQueueService] extendVisibility (verify) failed for jobId=${jobId}:`,
                    formattedMsg,
                    error,
                  )
                  return Effect.fail(
                    new AcknowledgeError({
                      jobId,
                      message: `Failed to verify job: ${formattedMsg}`,
                      cause: error,
                    }),
                  )
                }),
              )

            if (!exists[0]) {
              return yield* new JobNotFoundError({ jobId })
            }

            if (exists[0].claimReceipt !== receipt) {
              return yield* new StaleJobClaimError({ jobId })
            }

            return yield* new AcknowledgeError({
              jobId,
              message: "Cannot extend visibility of unlocked job",
            })
          }
        }),

      getStats: (queue: string) =>
        Effect.gen(function* () {
          yield* validateQueueName(queue)
          const db = yield* TypedPostgresDrizzle
          const now = yield* DateTime.now
          // For raw SQL CASE expressions, convert Effect DateTime to JS Date
          // This matches the effectDateTime custom type's toDriver conversion
          const nowDate = DateTime.toDateUtc(now)

          const stats = yield* db
            .select({
              pending: sql<string>`COUNT(CASE
              WHEN (${schema.jobQueue.lockedUntil} IS NULL OR ${schema.jobQueue.lockedUntil} <= ${nowDate})
                AND ${schema.jobQueue.jobAttempts} < ${schema.jobQueue.jobRetryLimit}
              THEN 1 END)`,
              processing: sql<string>`COUNT(CASE
              WHEN ${schema.jobQueue.lockedUntil} > ${nowDate}
              THEN 1 END)`,
              deadLetter: sql<string>`COUNT(CASE
              WHEN ${schema.jobQueue.jobAttempts} >= ${schema.jobQueue.jobRetryLimit}
              THEN 1 END)`,
            })
            .from(schema.jobQueue)
            .where(
              and(
                eq(schema.jobQueue.queue, queue),
                eq(schema.jobQueue._deleted, false),
              ),
            )
            .pipe(
              Effect.tapErrorCause((cause) =>
                Effect.logWarning("getStats query failed").pipe(
                  Effect.annotateLogs({
                    queue,
                    cause: Cause.pretty(cause),
                  }),
                ),
              ),
              Effect.catchAll(() =>
                Effect.succeed([
                  { pending: "0", processing: "0", deadLetter: "0" },
                ]),
              ),
            )

          const row = stats[0]
          return {
            pending: row ? Number(row.pending) : 0,
            processing: row ? Number(row.processing) : 0,
            deadLetter: row ? Number(row.deadLetter) : 0,
          }
        }),
    }
    return QueueService.of(closeQueue(queue, context))
  }),
)
