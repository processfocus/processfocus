import {
  AcknowledgeError,
  ClaimError,
  DEFAULT_MAX_RETRIES,
  DEFAULT_VISIBILITY_TIMEOUT,
  EnqueueError,
  type JobClaim,
  JobNotFoundError,
  type Payload,
  QueueService,
  type QueueServiceShape,
  QueueStatsError,
  type RawJob,
  StaleJobClaimError,
  closeQueue,
  validateQueueName,
} from "@processfocus/runtime"
import {
  type SQL,
  and,
  eq,
  gt,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm"
import { Context, DateTime, Duration, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import {
  TransactionCommitCallbacks,
  formatSqlError,
  getTursoHttpStatus,
} from "@pf/db-info"
import * as schema from "@pf/drizzle-sqlite"
import {
  type UserDetails,
  getUserDetails,
  returnedRow,
} from "@pf/graphql-db-operations"
import { type RequestTime, getRequestTime } from "@pf/request-time"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"
import { retryTransientSqliteError } from "@pf/sqlite-operations"

/** Lets an aggregating caller avoid re-logging the same queue failure. */
export const LoggedSqliteQueueFailures = Context.Reference<
  WeakSet<object> | undefined
>("@pf/sqlite-queue-service/LoggedSqliteQueueFailures", {
  defaultValue: () => undefined,
})

const logQueueFailure = <
  E extends EnqueueError | ClaimError | AcknowledgeError,
>(
  operation: string,
  summary: string,
  error: E,
): Effect.Effect<never, E> =>
  Effect.gen(function* () {
    const httpStatus = getTursoHttpStatus(error.cause)
    yield* Effect.logError("SQLite queue operation failed", {
      operation,
      ...("queue" in error ? { queue: error.queue } : { jobId: error.jobId }),
      httpStatus,
      error: summary.slice(0, 512),
    })
    const logged = yield* LoggedSqliteQueueFailures
    logged?.add(error)
    return yield* Effect.fail(error)
  })

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

// Two binds per claim, below SQLite's conservative 999-variable limit.
const ACKNOWLEDGE_BATCH_SIZE = 499

// Reserve the writer before sampling lease time: the driver's native busy wait
// can cross expiry without returning an error to our retry loop. The zero-row
// write fires no row triggers and also reserves an inherited deferred transaction
// without changing the driver's transaction mode or committing the caller's work.
const retryWithClaimTime = <A, E, R>(
  query: (now: DateTime.Utc) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const client = yield* SqlClient.SqlClient
    const db = yield* TypedSqliteDrizzle
    const transaction = yield* Effect.serviceOption(client.transactionService)
    const mutate = Effect.gen(function* () {
      yield* db
        .update(schema.jobQueue)
        .set({
          claimReceipt: sql`${schema.jobQueue.claimReceipt}`,
        })
        .where(sql`0`)
      return yield* Effect.flatMap(DateTime.now, query)
    })
    // Do not introduce a savepoint before writer acquisition: on Turso that
    // would pin a deferred snapshot while the competing writer is still live.
    return yield* (
      Option.isSome(transaction) ? mutate : client.withTransaction(mutate)
    ).pipe(retryTransientSqliteError)
  })

const attemptBudget = (queue: string, retryLimit: number | undefined) => {
  if (retryLimit === undefined) return Effect.succeed(DEFAULT_MAX_RETRIES)
  return Number.isSafeInteger(retryLimit) &&
    retryLimit >= 0 &&
    Number.isSafeInteger(retryLimit + 1)
    ? Effect.succeed(retryLimit + 1)
    : Effect.fail(
        new EnqueueError({
          queue,
          message:
            "retryLimit must be a non-negative safe integer with a safe retryLimit + 1 total-attempt budget",
        }),
      )
}

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

const reportEnqueue = Effect.fnUntraced(function* (
  queue: string,
  jobId: string,
) {
  const sqlClient = yield* SqlClient.SqlClient
  const transaction = yield* Effect.serviceOption(sqlClient.transactionService)
  const accepted = Effect.logInfo("Queue enqueue accepted", {
    queue,
    jobId,
    acceptance: "accepted",
  })
  if (Option.isNone(transaction)) {
    yield* accepted
    return
  }
  yield* Effect.logInfo(
    "Queue enqueue staged (provisional until outer commit)",
    {
      queue,
      jobId,
      acceptance: "staged",
    },
  )
  const callbacks = yield* Effect.serviceOption(TransactionCommitCallbacks)
  if (
    Option.isSome(callbacks) &&
    callbacks.value.transactionKey === sqlClient.transactionService.key
  ) {
    callbacks.value.callbacks.push(accepted)
  }
})

const AdditionalClaimCondition = Context.Reference<
  ((queue: string) => SQL | undefined) | undefined
>("@pf/sqlite-queue-service/AdditionalClaimCondition", {
  defaultValue: () => undefined,
})

const QueueLive = Layer.effect(
  QueueService,
  Effect.gen(function* () {
    const context = yield* Effect.context<SqliteQueueRequirements>()
    const additionalClaimCondition = yield* AdditionalClaimCondition
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
          const maxAttempts = yield* attemptBudget(queue, options?.retryLimit)
          const db = yield* TypedSqliteDrizzle
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()

          const result = yield* db
            .insert(schema.jobQueue)
            .values({
              queue,
              jobPayload: payload as Record<string, unknown>,
              jobRetryLimit: maxAttempts,
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
                return logQueueFailure(
                  "enqueue",
                  formattedMsg,
                  new EnqueueError({
                    queue,
                    message: `Database error: ${formattedMsg}`,
                    cause: error,
                  }),
                )
              }),
            )

          const row = yield* returnedRow(result)
          yield* reportEnqueue(queue, row.id)
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
          const maxAttempts = yield* attemptBudget(queue, options?.retryLimit)
          const delayMs = Duration.toMillis(delay)
          if (!Number.isFinite(delayMs) || delayMs < 0) {
            return yield* new EnqueueError({
              queue,
              message: "Scheduling delay must be finite and non-negative",
            })
          }
          const db = yield* TypedSqliteDrizzle
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()
          const availableAt = DateTime.add(requestTime, {
            milliseconds: delayMs,
          })

          const result = yield* db
            .insert(schema.jobQueue)
            .values({
              queue,
              jobPayload: payload as Record<string, unknown>,
              jobRetryLimit: maxAttempts,
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
                return logQueueFailure(
                  "enqueueWithDelay",
                  formattedMsg,
                  new EnqueueError({
                    queue,
                    message: `Database error: ${formattedMsg}`,
                    cause: error,
                  }),
                )
              }),
            )

          const row = yield* returnedRow(result)
          yield* reportEnqueue(queue, row.id)
          return row.id
        }),

      rawClaim: (name, visibilityTimeout) =>
        queue
          .rawClaimBatch(name, 1, visibilityTimeout)
          .pipe(Effect.map(Option.fromIterable)),

      rawClaimBatch: (
        queue: string,
        limit: number,
        visibilityTimeout?: Duration.Duration,
      ) =>
        Effect.gen(function* () {
          yield* validateQueueName(queue)
          const sqlClient = yield* SqlClient.SqlClient
          if (!Number.isSafeInteger(limit) || limit <= 0) {
            return yield* new ClaimError({
              queue,
              message: "Claim limit must be a positive safe integer",
            })
          }
          const db = yield* TypedSqliteDrizzle
          const now = yield* DateTime.now
          const timeout = visibilityTimeout ?? DEFAULT_VISIBILITY_TIMEOUT
          const timeoutMs = Duration.toMillis(timeout)
          const lockedUntil = DateTime.add(now, { milliseconds: timeoutMs })

          // Conditions for finding an available job
          const availableJobConditions = and(
            isNull(schema.jobQueue.terminalAt),
            or(
              eq(schema.jobQueue.queue, queue),
              additionalClaimCondition?.(queue),
            ),
            lte(schema.jobQueue.availableAt, now),
            or(
              isNull(schema.jobQueue.lockedUntil),
              lte(schema.jobQueue.lockedUntil, now),
            ),
            lt(schema.jobQueue.jobAttempts, schema.jobQueue.jobRetryLimit),
            // Literal SQL 0 matches the ready-jobs partial index on Turso.
            eq(schema.jobQueue._deleted, sql`0`),
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
                return logQueueFailure(
                  "rawClaim.check",
                  formattedMsg,
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
            return []
          }

          // Job found - claim it inside a driver-owned transaction.
          // SQLite has no FOR UPDATE SKIP LOCKED; the advisory read above only
          // avoids empty-queue write work. Re-check availability in the
          // transaction because another worker may have claimed the job.
          return yield* sqlClient
            .withTransaction(
              Effect.gen(function* () {
                // Keep LIMIT literal: Turso drops a bound LIMIT in the subquery.
                // https://github.com/tursodatabase/turso/issues/9929
                const nextJobId = sql`(
                  select ${schema.jobQueue.id}
                  from ${schema.jobQueue}
                  where ${availableJobConditions}
                  order by ${schema.jobQueue.jobAttempts}, ${schema.jobQueue.availableAt}, ${schema.jobQueue.id}
                  limit ${sql.raw(String(limit))}
                )`

                const result = yield* db
                  .update(schema.jobQueue)
                  .set({
                    lockedUntil,
                    claimReceipt: sql`lower(hex(randomblob(16)))`,
                    jobAttempts: sql`${schema.jobQueue.jobAttempts} + 1`,
                  })
                  .where(sql`${schema.jobQueue.id} IN ${nextJobId}`)
                  .returning({
                    id: schema.jobQueue.id,
                    queue: schema.jobQueue.queue,
                    jobPayload: schema.jobQueue.jobPayload,
                    jobAttempts: schema.jobQueue.jobAttempts,
                    jobRetryLimit: schema.jobQueue.jobRetryLimit,
                    availableAt: schema.jobQueue.availableAt,
                    // The UPDATE always sets a fresh non-null receipt.
                    claimReceipt: sql<string>`${schema.jobQueue.claimReceipt}`,
                  })

                // UPDATE RETURNING has no ordering guarantee. All attempts increased
                // equally, so sorting returned rows preserves the selection order.
                return result
                  .sort(
                    (left, right) =>
                      left.jobAttempts - right.jobAttempts ||
                      DateTime.toEpochMillis(left.availableAt) -
                        DateTime.toEpochMillis(right.availableAt) ||
                      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
                  )
                  .map(
                    (row): RawJob => ({
                      jobId: row.id,
                      receipt: row.claimReceipt,
                      queue: row.queue,
                      payload: row.jobPayload,
                      attempts: row.jobAttempts,
                      maxAttempts: row.jobRetryLimit,
                      availableAt: row.availableAt,
                      lockedUntil,
                    }),
                  )
              }),
            )
            .pipe(
              retryTransientSqliteError,
              Effect.catchTag("SqlError", (error: SqlError) => {
                const formattedMsg = formatSqlError(error)
                return logQueueFailure(
                  "rawClaim",
                  formattedMsg,
                  new ClaimError({
                    queue,
                    message: `Database error: ${formattedMsg}`,
                    cause: error,
                  }),
                )
              }),
            )
        }),

      acknowledgeBatch: (claims: readonly JobClaim[]) =>
        Effect.gen(function* () {
          const first = claims[0]
          if (!first) return []
          const db = yield* TypedSqliteDrizzle
          const acknowledge = Effect.gen(function* () {
            const deletedIds: string[] = []
            for (
              let offset = 0;
              offset < claims.length;
              offset += ACKNOWLEDGE_BATCH_SIZE
            ) {
              const pairs = claims
                .slice(offset, offset + ACKNOWLEDGE_BATCH_SIZE)
                .map(({ jobId, receipt }) => sql`(${jobId}, ${receipt})`)
              const rows = yield* retryWithClaimTime((now) =>
                db
                  .delete(schema.jobQueue)
                  .where(
                    and(
                      sql`(${schema.jobQueue.id}, ${schema.jobQueue.claimReceipt}) IN (VALUES ${sql.join(pairs, sql`, `)})`,
                      gt(schema.jobQueue.lockedUntil, now),
                    ),
                  )
                  .returning({ id: schema.jobQueue.id }),
              )
              deletedIds.push(...rows.map((row) => row.id))
            }
            return deletedIds
          })
          const sqlClient = yield* SqlClient.SqlClient
          // Keep multi-statement acknowledgements atomic, like a single DELETE.
          return yield* (
            claims.length > ACKNOWLEDGE_BATCH_SIZE
              ? sqlClient.withTransaction(acknowledge)
              : acknowledge
          ).pipe(
            Effect.mapError(
              (cause) =>
                new AcknowledgeError({
                  jobId: first.jobId,
                  message: `Failed to acknowledge batch: ${formatSqlError(cause)}`,
                  cause,
                }),
            ),
          )
        }),

      acknowledge: (jobId: string, receipt: string) =>
        Effect.gen(function* () {
          const db = yield* TypedSqliteDrizzle
          const result = yield* retryWithClaimTime((now) =>
            db
              .delete(schema.jobQueue)
              .where(
                and(
                  eq(schema.jobQueue.id, jobId),
                  eq(schema.jobQueue.claimReceipt, receipt),
                  gt(schema.jobQueue.lockedUntil, now),
                ),
              )
              .returning({ id: schema.jobQueue.id }),
          ).pipe(
            Effect.catchTag("SqlError", (error: SqlError) => {
              const formattedMsg = formatSqlError(error)
              return logQueueFailure(
                "acknowledge",
                formattedMsg,
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
          readonly reason?: string
        },
      ) =>
        Effect.gen(function* () {
          const db = yield* TypedSqliteDrizzle

          // A reported final failure is recorded immediately, not inferred later
          // from an attempt counter. One row UPDATE is both evidence and retirement.
          {
            const result = yield* retryWithClaimTime((now) =>
              db
                .update(schema.jobQueue)
                .set({
                  terminalAt: now,
                  terminalReason:
                    options?.reason ??
                    (options?.retryable === false
                      ? "Non-retryable failure reported without a diagnostic reason"
                      : "Attempt ended without a known handler outcome"),
                  terminalOutcome:
                    options?.retryable === false ||
                    options?.reason !== undefined
                      ? "handler-failure"
                      : "unknown",
                  lockedUntil: null,
                  claimReceipt: null,
                })
                .where(
                  and(
                    eq(schema.jobQueue.id, jobId),
                    eq(schema.jobQueue.claimReceipt, receipt),
                    gt(schema.jobQueue.lockedUntil, now),
                    isNull(schema.jobQueue.terminalAt),
                    options?.retryable === false
                      ? sql`1`
                      : sql`${schema.jobQueue.jobAttempts} >= ${schema.jobQueue.jobRetryLimit}`,
                  ),
                )
                .returning({ queue: schema.jobQueue.queue }),
            ).pipe(
              Effect.catchTag("SqlError", (error: SqlError) => {
                const formattedMsg = formatSqlError(error)
                return logQueueFailure(
                  "fail.terminal",
                  formattedMsg,
                  new AcknowledgeError({
                    jobId,
                    message: `Failed to dead-letter job: ${formattedMsg}`,
                    cause: error,
                  }),
                )
              }),
            )

            if (result[0]) {
              yield* Effect.logWarning(
                "Queue job terminal disposition recorded",
                {
                  jobId,
                  queue: result[0].queue,
                  outcome:
                    options?.retryable === false ||
                    options?.reason !== undefined
                      ? "handler-failure"
                      : "unknown",
                  reason: options?.reason,
                },
              )
              return
            }
            if (options?.retryable === false) {
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

          if (options?.releaseImmediately) {
            // End the lease now, retaining the start of the new eligible wait
            // for diagnostics without changing dispatch's availableAt priority.
            const result = yield* retryWithClaimTime((now) =>
              db
                .update(schema.jobQueue)
                .set({ lockedUntil: now, claimReceipt: null })
                .where(
                  and(
                    eq(schema.jobQueue.id, jobId),
                    eq(schema.jobQueue.claimReceipt, receipt),
                    gt(schema.jobQueue.lockedUntil, now),
                  ),
                )
                .returning({ id: schema.jobQueue.id }),
            ).pipe(
              Effect.catchTag("SqlError", (error: SqlError) => {
                const formattedMsg = formatSqlError(error)
                return logQueueFailure(
                  "fail.releaseImmediately",
                  formattedMsg,
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
            const result = yield* Effect.flatMap(DateTime.now, (now) =>
              db
                .select({ id: schema.jobQueue.id })
                .from(schema.jobQueue)
                .where(
                  and(
                    eq(schema.jobQueue.id, jobId),
                    eq(schema.jobQueue.claimReceipt, receipt),
                    gt(schema.jobQueue.lockedUntil, now),
                  ),
                ),
            ).pipe(
              retryTransientSqliteError,
              Effect.catchTag("SqlError", (error: SqlError) => {
                const formattedMsg = formatSqlError(error)
                return logQueueFailure(
                  "fail.verify",
                  formattedMsg,
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
          const timeoutMs = Duration.toMillis(timeout)
          if (
            !Number.isSafeInteger(timeoutMs) ||
            timeoutMs <= 0 ||
            timeoutMs > 2_147_483_647
          ) {
            return yield* new AcknowledgeError({
              jobId,
              message:
                "Visibility timeout must be a positive integer <= 2147483647 milliseconds",
            })
          }
          // Atomic UPDATE with WHERE clause checking both existence and lock status
          // This prevents race conditions where another worker could acknowledge/delete
          // the job between a SELECT and UPDATE
          const result = yield* retryWithClaimTime((now) =>
            db
              .update(schema.jobQueue)
              .set({
                lockedUntil: DateTime.add(now, { milliseconds: timeoutMs }),
              })
              .where(
                and(
                  eq(schema.jobQueue.id, jobId),
                  eq(schema.jobQueue.claimReceipt, receipt),
                  gt(schema.jobQueue.lockedUntil, now),
                ),
              )
              .returning({ id: schema.jobQueue.id }),
          ).pipe(
            Effect.catchTag("SqlError", (error: SqlError) => {
              const formattedMsg = formatSqlError(error)
              return logQueueFailure(
                "extendVisibility",
                formattedMsg,
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
                  return logQueueFailure(
                    "extendVisibility.verify",
                    formattedMsg,
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
              WHEN ${schema.jobQueue.terminalAt} IS NULL AND (${schema.jobQueue.lockedUntil} IS NULL OR ${schema.jobQueue.lockedUntil} <= ${nowJulian})
                AND ${schema.jobQueue.jobAttempts} < ${schema.jobQueue.jobRetryLimit}
              THEN 1 END)`,
              processing: sql<number>`COUNT(CASE
              WHEN ${schema.jobQueue.terminalAt} IS NULL AND ${schema.jobQueue.lockedUntil} > ${nowJulian}
              THEN 1 END)`,
              deadLetter: sql<number>`COUNT(CASE
              WHEN ${schema.jobQueue.terminalAt} IS NOT NULL
              THEN 1 END)`,
            })
            .from(schema.jobQueue)
            .where(
              and(
                eq(schema.jobQueue.queue, queue),
                eq(schema.jobQueue._deleted, sql`0`),
              ),
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new QueueStatsError({
                    queue,
                    message: "Queue statistics unavailable",
                    cause,
                  }),
              ),
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

export interface SqliteQueueHealth {
  readonly queue: string
  eligible: number
  delayed: number
  processing: number
  recoveryNeeded: number
  terminal: number
  oldestEligible: { readonly jobId: string; readonly waitingMs: number } | null
}

// A single read snapshot, with no writes or payloads. Lease expiry restarts the
// current eligible wait; future scheduling and valid ownership are not waiting.
const readSqliteQueueHealth = Effect.gen(function* () {
  const db = yield* TypedSqliteDrizzle
  const now = DateTime.toEpochMillis(yield* DateTime.now)
  const rows = yield* db
    .select({
      jobId: schema.jobQueue.id,
      queue: schema.jobQueue.queue,
      availableAt: schema.jobQueue.availableAt,
      lockedUntil: schema.jobQueue.lockedUntil,
      attempts: schema.jobQueue.jobAttempts,
      limit: schema.jobQueue.jobRetryLimit,
      terminalAt: schema.jobQueue.terminalAt,
    })
    .from(schema.jobQueue)
    .where(eq(schema.jobQueue._deleted, sql`0`))
  const queues = new Map<string, SqliteQueueHealth>()
  for (const row of rows) {
    const health = queues.get(row.queue) ?? {
      queue: row.queue,
      eligible: 0,
      delayed: 0,
      processing: 0,
      recoveryNeeded: 0,
      terminal: 0,
      oldestEligible: null,
    }
    queues.set(row.queue, health)
    const lease =
      row.lockedUntil === null ? 0 : DateTime.toEpochMillis(row.lockedUntil)
    const available = DateTime.toEpochMillis(row.availableAt)
    if (row.terminalAt !== null) health.terminal++
    else if (lease > now) health.processing++
    else if (row.attempts >= row.limit) health.recoveryNeeded++
    else if (available > now) health.delayed++
    else {
      health.eligible++
      const waitingMs = Math.max(0, now - Math.max(available, lease))
      if (
        health.oldestEligible === null ||
        waitingMs > health.oldestEligible.waitingMs
      )
        health.oldestEligible = { jobId: row.jobId, waitingMs }
    }
  }
  return [...queues.values()]
}).pipe(
  Effect.mapError(
    (cause) =>
      new QueueStatsError({
        queue: "*",
        message: "Queue health unavailable",
        cause,
      }),
  ),
)

/** Adapter policy: terminal rows are retained indefinitely, including after redrive.
 * There is no polling-based purge or automatic budget reset.
 */
export class SqliteQueueMaintenance extends Context.Service<
  SqliteQueueMaintenance,
  {
    readonly recover: () => Effect.Effect<number, AcknowledgeError>
    readonly inspect: () => Effect.Effect<
      readonly SqliteQueueHealth[],
      QueueStatsError
    >
    readonly redrive: (
      jobId: string,
    ) => Effect.Effect<string, AcknowledgeError | JobNotFoundError>
  }
>()("@pf/sqlite-queue-service/SqliteQueueMaintenance") {}

const MaintenanceLive = Layer.effect(
  SqliteQueueMaintenance,
  Effect.gen(function* () {
    const context = yield* Effect.context<SqliteQueueRequirements>()
    const provide = Effect.updateContext<never, SqliteQueueRequirements>(
      (caller) => Context.merge(context, caller),
    )
    return SqliteQueueMaintenance.of({
      inspect: () => readSqliteQueueHealth.pipe(provide),
      recover: () =>
        Effect.gen(function* () {
          const db = yield* TypedSqliteDrizzle
          const rows = yield* retryWithClaimTime((now) =>
            db
              .update(schema.jobQueue)
              .set({
                terminalAt: now,
                terminalReason:
                  "Attempt budget exhausted without a recorded outcome (abandoned or legacy claim)",
                terminalOutcome: "unknown",
                lockedUntil: null,
                claimReceipt: null,
              })
              .where(
                and(
                  eq(schema.jobQueue._deleted, sql`0`),
                  isNull(schema.jobQueue.terminalAt),
                  sql`${schema.jobQueue.jobAttempts} >= ${schema.jobQueue.jobRetryLimit}`,
                  or(
                    isNull(schema.jobQueue.lockedUntil),
                    lte(schema.jobQueue.lockedUntil, now),
                  ),
                ),
              )
              .returning({ id: schema.jobQueue.id }),
          )
          return rows.length
        }).pipe(
          provide,
          Effect.mapError(
            (cause) =>
              new AcknowledgeError({
                jobId: "maintenance",
                message: "Failed to recover exhausted queue jobs",
                cause,
              }),
          ),
        ),
      redrive: (jobId) =>
        Effect.gen(function* () {
          const db = yield* TypedSqliteDrizzle
          const client = yield* SqlClient.SqlClient
          const accepted = yield* client
            .withTransaction(
              Effect.gen(function* () {
                const [prior] = yield* db
                  .select()
                  .from(schema.jobQueue)
                  .where(
                    and(
                      eq(schema.jobQueue.id, jobId),
                      isNotNull(schema.jobQueue.terminalAt),
                    ),
                  )
                if (!prior) return yield* new JobNotFoundError({ jobId })
                const now = yield* getRequestTime()
                const user = yield* getUserDetails()
                const rows = yield* db
                  .insert(schema.jobQueue)
                  .values({
                    queue: prior.queue,
                    jobPayload: prior.jobPayload,
                    jobRetryLimit: prior.jobRetryLimit,
                    availableAt: now,
                    createdAt: now,
                    updatedAt: now,
                    createdBy: user.by,
                    updatedBy: user.by,
                    redrivenFrom: jobId,
                  })
                  .returning({ id: schema.jobQueue.id })
                return { id: (yield* returnedRow(rows)).id, queue: prior.queue }
              }),
            )
            .pipe(retryTransientSqliteError)
          yield* reportEnqueue(accepted.queue, accepted.id)
          return accepted.id
        }).pipe(
          provide,
          Effect.catchTag(
            "SqlError",
            (cause) =>
              new AcknowledgeError({
                jobId,
                message: "Failed to redrive terminal job",
                cause,
              }),
          ),
        ),
    })
  }),
)

/** Add an alternative storage selector without bypassing claim eligibility checks. */
export const makeSqliteQueueServiceLayer = (
  additionalClaimCondition: (queue: string) => SQL | undefined,
) =>
  // A scoped selector must not reuse a QueueLive built without it.
  Layer.fresh(QueueLive).pipe(
    Layer.provide(
      Layer.succeed(AdditionalClaimCondition, additionalClaimCondition),
    ),
  )

export const SqliteQueueServiceLive = Layer.merge(QueueLive, MaintenanceLive)
