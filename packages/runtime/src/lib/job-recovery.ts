import { Context, Data, Effect, Option, Schema } from "effect"

/** A claim-scoped fence, checked inside the owning domain transaction. */
export class JobAttempt extends Context.Service<
  JobAttempt,
  {
    readonly isCurrent: Effect.Effect<boolean, JobRecoveryError>
  }
>()("@processfocus/runtime/JobAttempt") {}

export class JobRecoveryError extends Data.TaggedError("JobRecoveryError")<{
  readonly message: string
}> {}

export const isJobAttemptCurrent: Effect.Effect<boolean, JobRecoveryError> =
  Effect.flatMap(Effect.serviceOption(JobAttempt), (attempt) =>
    Option.isSome(attempt) ? attempt.value.isCurrent : Effect.succeed(true),
  )

export const JobFailureEvidence = Schema.Struct({
  jobId: Schema.String,
  queue: Schema.String,
  sourceMessageId: Schema.String,
  source: Schema.String,
  attempts: Schema.Number,
  maxAttempts: Schema.Number,
  observedReceiveCount: Schema.Number,
  enqueuedAt: Schema.Number,
  reason: Schema.String,
  recordedAt: Schema.Number,
  outcome: Schema.Literals(["known-failure", "unknown"]),
  domainReference: Schema.optional(Schema.String),
  previousJobId: Schema.optional(Schema.String),
})
export type JobFailureEvidence = typeof JobFailureEvidence.Type

/** Diagnostics and deliberate recovery, never called by ordinary polling. */
export class JobRecovery extends Context.Service<
  JobRecovery,
  {
    readonly failures: Effect.Effect<
      readonly JobFailureEvidence[],
      JobRecoveryError
    >
    readonly redrive: (input: {
      readonly queue: string
      readonly jobId: string
      /** Stable operator request id: retrying the request must reuse this id. */
      readonly requestId: string
    }) => Effect.Effect<string, JobRecoveryError>
  }
>()("@processfocus/runtime/JobRecovery") {}
