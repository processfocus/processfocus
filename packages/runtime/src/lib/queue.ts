import type { DateTime } from "effect"
import { Context, Data, Duration, Effect, Option, Schema } from "effect"
import type { ParseError } from "effect/ParseResult"

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

export interface QueueStats {
  readonly pending: number
  readonly processing: number
  readonly deadLetter: number
}

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
  readonly enqueue: <P extends QueuePayload>(
    queue: string,
    payload: P,
    options?: {
      readonly retryLimit?: number
      readonly logicalJobId?: string
    },
  ) => Effect.Effect<string, EnqueueError | InvalidQueueNameError, R>
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
  ) => Effect.Effect<QueueStats, InvalidQueueNameError, R>
}

export type Queue = QueueServiceShape

export const closeQueue = <R>(
  queue: QueueServiceShape<R>,
  context: Context.Context<R>,
): Queue => ({
  queueInTransaction: queue.queueInTransaction,
  enqueue: (name, payload, options) =>
    queue.enqueue(name, payload, options).pipe(Effect.provide(context)),
  enqueueWithDelay: (name, payload, delay, options) =>
    queue
      .enqueueWithDelay(name, payload, delay, options)
      .pipe(Effect.provide(context)),
  rawClaim: (name, visibilityTimeout) =>
    queue.rawClaim(name, visibilityTimeout).pipe(Effect.provide(context)),
  acknowledge: (jobId, receipt) =>
    queue.acknowledge(jobId, receipt).pipe(Effect.provide(context)),
  fail: (jobId, receipt, options) =>
    queue.fail(jobId, receipt, options).pipe(Effect.provide(context)),
  extendVisibility: (jobId, receipt, timeout) =>
    queue
      .extendVisibility(jobId, receipt, timeout)
      .pipe(Effect.provide(context)),
  getStats: (name) => queue.getStats(name).pipe(Effect.provide(context)),
})

export class QueueService extends Context.Tag(
  "@processfocus/runtime/QueueService",
)<QueueService, Queue>() {
  static claim = <A, I>(
    queue: string,
    schema: Schema.Schema<A, I>,
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
      const payload = yield* Schema.decodeUnknown(schema)(rawJob.payload).pipe(
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
