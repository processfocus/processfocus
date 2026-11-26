import type { DateTime } from "effect"
import { Context, Data, Duration, Effect, Option, Schema } from "effect"
import type { SchemaError as ParseError } from "effect/Schema"

export type QueuePayload = Record<string, unknown>

export interface RawJob {
  readonly jobId: string
  readonly receipt: string
  readonly queue: string
  readonly payload: unknown
  readonly attempts: number
  readonly maxAttempts: number
  readonly availableAt: DateTime.Utc
  readonly lockedUntil: DateTime.Utc
}

export interface Job<A> extends Omit<RawJob, "payload"> {
  readonly payload: A
}

export type JobClaim = Pick<RawJob, "jobId" | "receipt">

export interface QueueStats {
  readonly pending: number
  readonly processing: number
  readonly deadLetter: number
}

export class QueueStatsError extends Data.TaggedError("QueueStatsError")<{
  readonly queue: string
  readonly message: string
  readonly cause?: unknown
}> {}

export class EnqueueError extends Data.TaggedError("EnqueueError")<{
  readonly queue: string
  readonly message: string
  readonly cause?: unknown
}> {}

export class ClaimError extends Data.TaggedError("ClaimError")<{
  readonly queue: string
  readonly message: string
  readonly cause?: unknown
}> {}

export class AcknowledgeError extends Data.TaggedError("AcknowledgeError")<{
  readonly jobId: string
  readonly message: string
  readonly cause?: unknown
}> {}

export class JobNotFoundError extends Data.TaggedError("JobNotFoundError")<{
  readonly jobId: string
}> {}

export class StaleJobClaimError extends Data.TaggedError("StaleJobClaimError")<{
  readonly jobId: string
}> {}

export class InvalidQueueNameError extends Data.TaggedError(
  "InvalidQueueNameError",
)<{
  readonly queueName: string
  readonly message: string
}> {}

export class PayloadParseError extends Data.TaggedError("PayloadParseError")<{
  readonly queue: string
  readonly jobId: string
  readonly error: ParseError
}> {}

export const MAX_QUEUE_NAME_LENGTH = 80
export const DEFAULT_VISIBILITY_TIMEOUT = Duration.seconds(30)
export const DEFAULT_MAX_RETRIES = 5

const QUEUE_NAME_REGEX = /^[A-Za-z0-9._-]+$/

export const validateQueueName = (
  queueName: string,
): Effect.Effect<string, InvalidQueueNameError> => {
  if (queueName.length === 0) {
    return Effect.fail(
      new InvalidQueueNameError({
        queueName,
        message: "Queue name cannot be empty (minimum length is 1 character)",
      }),
    )
  }
  if (queueName.length > MAX_QUEUE_NAME_LENGTH) {
    return Effect.fail(
      new InvalidQueueNameError({
        queueName,
        message: `Queue name exceeds maximum length of ${MAX_QUEUE_NAME_LENGTH} characters (got ${queueName.length})`,
      }),
    )
  }
  if (!QUEUE_NAME_REGEX.test(queueName)) {
    return Effect.fail(
      new InvalidQueueNameError({
        queueName,
        message:
          "Queue name contains invalid characters. Only A-Z, a-z, 0-9, hyphens (-), underscores (_), and periods (.) are allowed. Spaces are NOT allowed.",
      }),
    )
  }
  return Effect.succeed(queueName)
}

export interface QueueServiceShape<R = never> {
  readonly queueInTransaction: boolean
  /**
   * Returns a physical ID, not a durable acknowledgement inside a database
   * transaction: it is staged until the outermost commit (including savepoints).
   * Autocommit/external success means accepted, even if already consumed.
   * Failure/lost response may follow a commit; retry can duplicate delivery.
   * Never delete committed work to compensate for a lost acknowledgement.
   */
  readonly enqueue: <P extends QueuePayload>(
    queue: string,
    payload: P,
    options?: {
      readonly retryLimit?: number
      readonly logicalJobId?: string
    },
  ) => Effect.Effect<string, EnqueueError | InvalidQueueNameError, R>
  /** Same provisional-versus-durable return contract as enqueue. */
  readonly enqueueWithDelay: <P extends QueuePayload>(
    queue: string,
    payload: P,
    delay: Duration.Duration,
    options?: {
      readonly retryLimit?: number
      readonly logicalJobId?: string
    },
  ) => Effect.Effect<string, EnqueueError | InvalidQueueNameError, R>
  readonly rawClaim: (
    queue: string,
    visibilityTimeout?: Duration.Duration,
  ) => Effect.Effect<
    Option.Option<RawJob>,
    ClaimError | InvalidQueueNameError,
    R
  >
  /** Positive integer limit; ordered by attempts, availability, then job ID. */
  readonly rawClaimBatch: (
    queue: string,
    limit: number,
    visibilityTimeout?: Duration.Duration,
  ) => Effect.Effect<readonly RawJob[], ClaimError | InvalidQueueNameError, R>
  /** Delete matching pairs only; return IDs actually acknowledged, ignoring stale/missing claims. */
  readonly acknowledgeBatch: (
    claims: readonly JobClaim[],
  ) => Effect.Effect<readonly string[], AcknowledgeError, R>
  readonly acknowledge: (
    jobId: string,
    receipt: string,
  ) => Effect.Effect<
    void,
    AcknowledgeError | JobNotFoundError | StaleJobClaimError,
    R
  >
  readonly fail: (
    jobId: string,
    receipt: string,
    options?: {
      readonly releaseImmediately?: boolean
      readonly retryable?: boolean
      /** Known failure diagnostic; omission is unknown unless explicitly non-retryable. */
      readonly reason?: string
    },
  ) => Effect.Effect<
    void,
    AcknowledgeError | JobNotFoundError | StaleJobClaimError,
    R
  >
  readonly extendVisibility: (
    jobId: string,
    receipt: string,
    timeout: Duration.Duration,
  ) => Effect.Effect<
    void,
    AcknowledgeError | JobNotFoundError | StaleJobClaimError,
    R
  >
  readonly getStats: (
    queue: string,
  ) => Effect.Effect<QueueStats, InvalidQueueNameError | QueueStatsError, R>
}

export type Queue = QueueServiceShape

export const closeQueue = <R>(
  queue: QueueServiceShape<R>,
  context: Context.Context<R>,
): Queue => {
  // Capture required services, while preserving request, clock and transaction
  // overrides from the operation's caller.
  const provide = Effect.updateContext<never, R>((caller) =>
    Context.merge(context, caller),
  )
  return {
    queueInTransaction: queue.queueInTransaction,
    enqueue: (name, payload, options) =>
      queue.enqueue(name, payload, options).pipe(provide),
    enqueueWithDelay: (name, payload, delay, options) =>
      queue.enqueueWithDelay(name, payload, delay, options).pipe(provide),
    rawClaim: (name, visibilityTimeout) =>
      queue.rawClaim(name, visibilityTimeout).pipe(provide),
    rawClaimBatch: (name, limit, visibilityTimeout) =>
      queue.rawClaimBatch(name, limit, visibilityTimeout).pipe(provide),
    acknowledgeBatch: (claims) => queue.acknowledgeBatch(claims).pipe(provide),
    acknowledge: (jobId, receipt) =>
      queue.acknowledge(jobId, receipt).pipe(provide),
    fail: (jobId, receipt, options) =>
      queue.fail(jobId, receipt, options).pipe(provide),
    extendVisibility: (jobId, receipt, timeout) =>
      queue.extendVisibility(jobId, receipt, timeout).pipe(provide),
    getStats: (name) => queue.getStats(name).pipe(provide),
  }
}

export class QueueService extends Context.Service<QueueService, Queue>()(
  "@processfocus/runtime/QueueService",
) {
  static claim = <A, I>(
    queue: string,
    schema: Schema.Codec<A, I>,
    visibilityTimeout?: Duration.Duration,
  ): Effect.Effect<
    Option.Option<Job<A>>,
    ClaimError | InvalidQueueNameError | PayloadParseError,
    QueueService
  > =>
    Effect.gen(function* () {
      const service = yield* QueueService
      const rawJobOption = yield* service.rawClaim(queue, visibilityTimeout)
      if (Option.isNone(rawJobOption)) return Option.none()

      const rawJob = rawJobOption.value
      const payload = yield* Schema.decodeUnknownEffect(schema)(
        rawJob.payload,
      ).pipe(
        Effect.mapError(
          (error) =>
            new PayloadParseError({ queue, jobId: rawJob.jobId, error }),
        ),
      )
      return Option.some<Job<A>>({ ...rawJob, payload })
    })
}

/** @deprecated Use QueuePayload. */
export type Payload = QueuePayload
