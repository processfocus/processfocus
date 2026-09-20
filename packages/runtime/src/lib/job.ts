import { Cause, Data, Effect, Exit, Option, Schema } from "effect"
import type { Job, RawJob } from "./queue.js"
import { PayloadParseError } from "./queue.js"

export interface JobHandler<A, I, E = never, R = never> {
  readonly schema: Schema.Schema<A, I>
  readonly handle: (job: Job<A>) => Effect.Effect<void, E, R>
}

export interface AnyJobHandler<E = never, R = never> {
  readonly execute: (
    job: RawJob,
  ) => Effect.Effect<void, E | PayloadParseError, R>
}

export type JobHandlers<E = never, R = never> = Readonly<
  Record<string, AnyJobHandler<E, R>>
>

export class UnknownJobQueueError extends Data.TaggedError(
  "UnknownJobQueueError",
)<{
  readonly queue: string
  readonly jobId: string
}> {}

export type JobDisposition =
  | { readonly kind: "acknowledge" }
  | { readonly kind: "retry"; readonly cause: Cause.Cause<unknown> }
  | { readonly kind: "terminal"; readonly cause: Cause.Cause<unknown> }

export interface JobDispatcher<R = never> {
  readonly dispatch: (job: RawJob) => Effect.Effect<JobDisposition, never, R>
}

export const jobHandler = <A, I, E, R>(
  handler: JobHandler<A, I, E, R>,
): AnyJobHandler<E, R> => ({
  execute: (rawJob) =>
    Effect.gen(function* () {
      const payload = yield* Schema.decodeUnknown(handler.schema)(
        rawJob.payload,
      ).pipe(
        Effect.mapError(
          (error) =>
            new PayloadParseError({
              queue: rawJob.queue,
              jobId: rawJob.jobId,
              error,
            }),
        ),
      )
      yield* handler.handle({ ...rawJob, payload })
    }),
})

const isNonRetryable = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "retryable" in error &&
  error.retryable === false

const isPayloadParseError = (error: unknown): error is PayloadParseError =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === "PayloadParseError"

const annotateJobFailure = (cause: Cause.Cause<unknown>) => {
  if (Cause.isInterruptedOnly(cause)) {
    return Effect.void
  }

  const message = Cause.pretty(cause)
  return Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan("job.failed", true)
    yield* Effect.annotateCurrentSpan("job.error", message)
    if (Option.isSome(Cause.dieOption(cause))) {
      yield* Effect.annotateCurrentSpan("job.defect", true)
    }
  })
}

export const makeJobDispatcher = <E, R, T extends JobHandlers<E, R>>(
  handlers: T,
  classifyError: (error: unknown) => "retry" | "terminal" = (error) =>
    isNonRetryable(error) ? "terminal" : "retry",
): JobDispatcher<R> => ({
  dispatch: (rawJob) =>
    Effect.gen(function* () {
      const handler = handlers[rawJob.queue]
      if (handler === undefined) {
        return {
          kind: "terminal",
          cause: Cause.fail(
            new UnknownJobQueueError({
              queue: rawJob.queue,
              jobId: rawJob.jobId,
            }),
          ),
        } satisfies JobDisposition
      }

      const handlerExit = yield* Effect.exit(
        handler.execute(rawJob).pipe(
          Effect.tapErrorCause(annotateJobFailure),
          Effect.withSpan(`job.process.${rawJob.queue}`, {
            attributes: {
              "job.id": rawJob.jobId,
              "job.queue": rawJob.queue,
              "job.attempts": rawJob.attempts,
            },
          }),
        ),
      )
      if (Exit.isSuccess(handlerExit)) {
        return { kind: "acknowledge" } satisfies JobDisposition
      }
      const failure = Cause.failureOption(handlerExit.cause)
      if (Option.isSome(failure) && isPayloadParseError(failure.value)) {
        return { kind: "terminal", cause: handlerExit.cause }
      }
      if (Option.isSome(failure)) {
        const disposition = classifyError(failure.value)
        return {
          kind: disposition,
          cause: handlerExit.cause,
        } satisfies JobDisposition
      }
      return {
        kind: "retry",
        cause: handlerExit.cause,
      } satisfies JobDisposition
    }),
})
