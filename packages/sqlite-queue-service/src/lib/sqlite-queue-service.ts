import { SqlClient } from "@effect/sql"
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
import * as schema from "@pf/drizzle-sqlite"
import {
  type UserDetails,
  getUserDetails,
  returnedRow,
} from "@pf/graphql-db-operations"
import { formatSqlError } from "@pf/queue-service"
import { type RequestTime, getRequestTime } from "@pf/request-time"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"
import { retryTransientSqliteError } from "@pf/sqlite-operations"

const mapClaimVerificationError = (jobId: string) =>
  Effect.mapError(
    (error: SqlError) =>
      new AcknowledgeError({
        jobId,
        message: `Failed to verify job claim: ${formatSqlError(error)}`,
        cause: error,
      }),
  )

// Constants for converting Unix epoch milliseconds to Julian day numbers
// SQLite stores dates as Julian day numbers (days since noon UTC on January 1, 4713 BC)
const MILLISECONDS_PER_DAY = 86400000
const UNIX_EPOCH_JULIAN_DAY = 2440587.5

/**
 * SQLite implementation of the QueueService.
 *
 * Claim uses `SqlClient.withTransaction` for atomic claim operations.
 * Transaction mode is owned by the supplied driver (not assumed here).
 * All operations require TypedSqliteDrizzle.
 */
type SqliteQueueRequirements =
  | SqlClient.SqlClient
  | RequestTime
  | TypedSqliteDrizzle
  | UserDetails

export const SqliteQueueServiceLive = Layer.effect(
  QueueService,
  Effect.gen(function* () {
    const context = yield* Effect.context<SqliteQueueRequirements>()
    const queue: QueueServiceShape<SqliteQueueRequirements> = {
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
          const db = yield* TypedSqliteDrizzle
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
              retryTransientSqliteError,
              Effect.catchTag("SqlError", (error: SqlError) => {
                const formattedMsg = formatSqlError(error)
                console.error(
                  `[SqliteQueueService] enqueue failed for queue=${queue}:`,
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
          const db = yield* TypedSqliteDrizzle
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
              retryTransientSqliteError,
              Effect.catchTag("SqlError", (error: SqlError) => {
                const formattedMsg = formatSqlError(error)
                console.error(
                  `[SqliteQueueService] enqueueWithDelay failed for queue=${queue}:`,
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
          const sqlClient = yield* SqlClient.SqlClient
          const db = yield* TypedSqliteDrizzle
          const now = yield* DateTime.now
          const timeout = visibilityTimeout ?? DEFAULT_VISIBILITY_TIMEOUT
          const timeoutMs = Duration.toMillis(timeout)
          const lockedUntil = DateTime.add(now, { millis: timeoutMs })
          const receipt = crypto.randomUUID()

          // Conditions for finding an available job
          const availableJobConditions = and(
            eq(schema.jobQueue.queue, queue),
            lte(schema.jobQueue.availableAt, now),
            or(
              isNull(schema.jobQueue.lockedUntil),
              lte(schema.jobQueue.lockedUntil, now),
            ),
            lt(schema.jobQueue.jobAttempts, schema.jobQueue.jobRetryLimit),
            eq(schema.jobQueue._deleted, false),
          )

          // First, do a read-only check to see if there's any job available.
          // This avoids acquiring a write lock when the queue is empty.
          const candidate = yield* db
            .select({ id: schema.jobQueue.id })
            .from(schema.jobQueue)
            .where(availableJobConditions)
            .limit(1)
            .pipe(
              retryTransientSqliteError,
              Effect.catchTag("SqlError", (error: SqlError) => {
                const formattedMsg = formatSqlError(error)
                console.error(
                  `[SqliteQueueService] rawClaim (check) failed for queue=${queue}:`,
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

          // No jobs available, return early without acquiring write lock
          if (!candidate[0]) {
            return Option.none()
          }

          // Job found - claim it inside a driver-owned transaction.
          // SQLite has no FOR UPDATE SKIP LOCKED; the advisory read above only
          // avoids empty-queue write work. Re-check availability in the
          // transaction because another worker may have claimed the job.
          return yield* sqlClient
            .withTransaction(
              Effect.gen(function* () {
                // Find the next available job using a subquery
                const nextJobSubquery = db
                  .select({ id: schema.jobQueue.id })
                  .from(schema.jobQueue)
                  .where(availableJobConditions)
                  .orderBy(
                    schema.jobQueue.jobAttempts,
                    schema.jobQueue.availableAt,
                    schema.jobQueue.id,
                  )
                  .limit(1)

                const result = yield* db
                  .update(schema.jobQueue)
                  .set({
                    lockedUntil,
                    claimReceipt: receipt,
                    jobAttempts: sql`${schema.jobQueue.jobAttempts} + 1`,
                  })
                  .where(eq(schema.jobQueue.id, nextJobSubquery))
                  .returning()

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
                  // Use the calculated lockedUntil since we just set it in the UPDATE
                  lockedUntil: lockedUntil,
                })
              }),
            )
            .pipe(
              retryTransientSqliteError,
              Effect.catchTag("SqlError", (error: SqlError) => {
                const formattedMsg = formatSqlError(error)
                console.error(
                  `[SqliteQueueService] rawClaim failed for queue=${queue}:`,
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
        }),

      acknowledge: (jobId: string, receipt: string) =>
        Effect.gen(function* () {
          const db = yield* TypedSqliteDrizzle

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
              retryTransientSqliteError,
              Effect.catchTag("SqlError", (error: SqlError) => {
                const formattedMsg = formatSqlError(error)
                console.error(
                  `[SqliteQueueService] acknowledge failed for jobId=${jobId}:`,
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
              .pipe(retryTransientSqliteError, mapClaimVerificationError(jobId))
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
          const db = yield* TypedSqliteDrizzle

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
                retryTransientSqliteError,
                Effect.catchTag("SqlError", (error: SqlError) => {
                  const formattedMsg = formatSqlError(error)
                  console.error(
                    `[SqliteQueueService] fail (terminal) failed for jobId=${jobId}:`,
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
                .pipe(
                  retryTransientSqliteError,
                  mapClaimVerificationError(jobId),
                )
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
                retryTransientSqliteError,
                Effect.catchTag("SqlError", (error: SqlError) => {
                  const formattedMsg = formatSqlError(error)
                  console.error(
                    `[SqliteQueueService] fail (releaseImmediately) failed for jobId=${jobId}:`,
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
                .pipe(
                  retryTransientSqliteError,
                  mapClaimVerificationError(jobId),
                )
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
                retryTransientSqliteError,
                Effect.catchTag("SqlError", (error: SqlError) => {
                  const formattedMsg = formatSqlError(error)
                  console.error(
                    `[SqliteQueueService] fail (verify) failed for jobId=${jobId}:`,
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
                .pipe(
                  retryTransientSqliteError,
                  mapClaimVerificationError(jobId),
                )
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
          const db = yield* TypedSqliteDrizzle
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
              retryTransientSqliteError,
              Effect.catchTag("SqlError", (error: SqlError) => {
                const formattedMsg = formatSqlError(error)
                console.error(
                  `[SqliteQueueService] extendVisibility failed for jobId=${jobId}:`,
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
                retryTransientSqliteError,
                Effect.catchTag("SqlError", (error: SqlError) => {
                  const formattedMsg = formatSqlError(error)
                  console.error(
                    `[SqliteQueueService] extendVisibility (verify) failed for jobId=${jobId}:`,
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
          const db = yield* TypedSqliteDrizzle
          const now = yield* DateTime.now
          // Convert Effect DateTime to Julian day for SQLite comparison
          const nowMillis = DateTime.toEpochMillis(now)
          const nowJulian =
            nowMillis / MILLISECONDS_PER_DAY + UNIX_EPOCH_JULIAN_DAY

          const stats = yield* db
            .select({
              pending: sql<number>`COUNT(CASE
              WHEN (${schema.jobQueue.lockedUntil} IS NULL OR ${schema.jobQueue.lockedUntil} <= ${nowJulian})
                AND ${schema.jobQueue.jobAttempts} < ${schema.jobQueue.jobRetryLimit}
              THEN 1 END)`,
              processing: sql<number>`COUNT(CASE
              WHEN ${schema.jobQueue.lockedUntil} > ${nowJulian}
              THEN 1 END)`,
              deadLetter: sql<number>`COUNT(CASE
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
              Effect.catchAll(() => Effect.succeed([])),
            )

          return (
            stats[0] ?? {
              pending: 0,
              processing: 0,
              deadLetter: 0,
            }
          )
        }),
    }
    return QueueService.of(closeQueue(queue, context))
  }),
)
