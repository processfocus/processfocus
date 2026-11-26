import { QueueService, type RawJob } from "@processfocus/runtime"
import {
  Cause,
  Data,
  DateTime,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
} from "effect"

export interface AttemptPolicy {
  readonly executionMs: number
  readonly cancellationGraceMs: number
  readonly queueIoMs: number
  readonly visibilityMs: number
}

export class InvalidAttemptPolicy extends Data.TaggedError(
  "InvalidAttemptPolicy",
)<{
  readonly message: string
}> {}

export class AttemptEscalation extends Data.TaggedError("AttemptEscalation")<{
  readonly kind: "supervision-required"
  readonly jobId: string | null
  readonly receipt: string | null
  readonly phase: string
  readonly executionDeadline: string | null
  readonly outcome: "unknown"
}> {}

export const readAttemptPolicy = Effect.fnUntraced(function* (
  overrides: Partial<AttemptPolicy> = {},
  env: NodeJS.ProcessEnv = process.env,
) {
  const policy: AttemptPolicy = {
    executionMs:
      overrides.executionMs ??
      Number(env["PF_LOCAL_QUEUE_EXECUTION_MS"] ?? 300_000),
    cancellationGraceMs:
      overrides.cancellationGraceMs ??
      Number(env["PF_LOCAL_QUEUE_CANCELLATION_GRACE_MS"] ?? 5_000),
    queueIoMs:
      overrides.queueIoMs ?? Number(env["PF_LOCAL_QUEUE_IO_MS"] ?? 5_000),
    visibilityMs:
      overrides.visibilityMs ??
      Number(env["PF_LOCAL_QUEUE_VISIBILITY_MS"] ?? 30_000),
  }
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
      return yield* new InvalidAttemptPolicy({
        message: `${name} must be a positive integer <= 2147483647 milliseconds`,
      })
    }
  }
  if (
    policy.queueIoMs +
      policy.cancellationGraceMs +
      Math.ceil(policy.visibilityMs / 3) >=
    policy.visibilityMs
  ) {
    return yield* new InvalidAttemptPolicy({
      message:
        "queueIoMs plus cancellationGraceMs and the renewal interval must be less than visibilityMs",
    })
  }
  return policy
})

// Wait on an observer, not on interrupt itself: Effect timeouts otherwise wait
// for uninterruptible finalizers. A stuck fiber remains owned by the process;
// callers MUST stop admission on escalation until independent supervision acts.
export const boundedQueueOperation = Effect.fnUntraced(function* <A, E, R>(
  operation: Effect.Effect<A, E, R>,
  policy: AttemptPolicy,
  escalation: AttemptEscalation,
  onEscalation: (error: AttemptEscalation) => void = () => {},
) {
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkDetach(Effect.interruptible(operation))
      const result = yield* restore(
        Fiber.await(fiber).pipe(Effect.timeoutOption(policy.queueIoMs)),
      ).pipe(Effect.exit)
      yield* Effect.sync(() => fiber.interruptUnsafe())
      const stopped = yield* Fiber.await(fiber).pipe(
        Effect.timeoutOption(policy.cancellationGraceMs),
      )
      if (Option.isNone(stopped)) {
        yield* Effect.sync(() => onEscalation(escalation))
        return yield* escalation
      }
      if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause)
      if (Option.isSome(result.value)) return yield* result.value.value
      const error = new AttemptEscalation({
        ...escalation,
        phase: `${escalation.phase}-timeout`,
      })
      yield* Effect.sync(() => onEscalation(error))
      return yield* error
    }),
  )
})

export const runLocalAttempt = Effect.fnUntraced(function* <E, R>(
  job: RawJob,
  operation: Effect.Effect<void, E, R>,
  policy: AttemptPolicy,
  onEscalation: (error: AttemptEscalation) => void = () => {},
) {
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const queue = yield* QueueService
      // The claim's initial lease timestamps its start, including dispatch overhead.
      const deadlineMs =
        DateTime.toEpochMillis(job.lockedUntil) -
        policy.visibilityMs +
        policy.executionMs
      const escalation = (phase: string): AttemptEscalation =>
        new AttemptEscalation({
          kind: "supervision-required",
          jobId: job.jobId,
          receipt: job.receipt,
          phase,
          executionDeadline: DateTime.formatIso(
            DateTime.makeUnsafe(deadlineMs),
          ),
          outcome: "unknown",
        })
      const attempt = yield* Effect.forkDetach(Effect.interruptible(operation))
      const remaining = () =>
        Effect.map(DateTime.now, (now) =>
          Math.max(0, deadlineMs - DateTime.toEpochMillis(now)),
        )
      const monitor = Effect.gen(function* () {
        while (true) {
          const left = yield* remaining()
          if (left === 0) return "execution-deadline"
          yield* Effect.sleep(
            Math.min(Math.floor(policy.visibilityMs / 3), left),
          )
          if ((yield* remaining()) === 0) return "execution-deadline"
          // I/O has its own bound; the independent deadline race below cancels
          // the watcher without a competing renewal-local execution timeout.
          yield* boundedQueueOperation(
            queue.extendVisibility(
              job.jobId,
              job.receipt,
              Duration.millis(policy.visibilityMs),
            ),
            policy,
            escalation("lease-renewal"),
            onEscalation,
          )
        }
      })
      const watcher = yield* Effect.forkDetach(Effect.interruptible(monitor))
      const result = yield* restore(
        Effect.gen(function* () {
          const result = yield* Effect.raceFirst(
            Fiber.await(attempt).pipe(
              Effect.map((exit) => ({ kind: "finished" as const, exit })),
            ),
            Effect.raceFirst(
              Fiber.await(watcher),
              Effect.sleep(yield* remaining()).pipe(
                Effect.as(Exit.succeed("execution-deadline")),
              ),
            ).pipe(Effect.map((exit) => ({ kind: "cancel" as const, exit }))),
          )
          if (result.kind === "cancel")
            yield* Effect.sync(() => attempt.interruptUnsafe())
          yield* Effect.sync(() => watcher.interruptUnsafe())
          const watcherStopped = yield* Fiber.await(watcher).pipe(
            Effect.timeoutOption(policy.cancellationGraceMs),
          )
          if (Option.isNone(watcherStopped))
            return yield* Effect.fail(escalation("lease-cleanup"))
          if (result.kind === "finished") {
            const watcherExit = watcherStopped.value
            if (
              Exit.isFailure(watcherExit) &&
              !Cause.hasInterruptsOnly(watcherExit.cause)
            )
              return yield* watcherExit
            return yield* result.exit
          }
          yield* Effect.logWarning(
            "Cancelling local queue attempt; external outcome may be unknown",
            {
              ...escalation(
                Exit.isSuccess(result.exit)
                  ? result.exit.value
                  : "ownership-lost-or-renewal-failed",
              ),
              attempt: job.attempts,
            },
          )
          yield* Effect.sync(() => attempt.interruptUnsafe())
          const stopped = yield* Fiber.await(attempt).pipe(
            Effect.timeoutOption(policy.cancellationGraceMs),
          )
          if (Option.isNone(stopped))
            return yield* Effect.fail(escalation("cancellation"))
          if (
            Exit.isFailure(stopped.value) &&
            !Cause.hasInterruptsOnly(stopped.value.cause)
          )
            return yield* stopped.value
          // Only stopped work may be made eligible again. A claim already consumed its
          // attempt; never reset it. The adapter fences any intervening newer claim.
          const released = yield* boundedQueueOperation(
            queue.fail(job.jobId, job.receipt, { releaseImmediately: true }),
            policy,
            escalation("cancel-release"),
            onEscalation,
          ).pipe(Effect.exit)
          if (Exit.isFailure(released)) {
            // Stale/missing receipts are a normal ownership-loss outcome, not a reason
            // to mutate the new owner's work or stop the worker.
            yield* released.pipe(
              Effect.catchTag(
                ["StaleJobClaimError", "JobNotFoundError"],
                () => Effect.void,
              ),
            )
          }
          if (Exit.isFailure(result.exit))
            yield* Effect.failCause(result.exit.cause).pipe(
              Effect.catchTag(
                ["StaleJobClaimError", "JobNotFoundError"],
                () => Effect.void,
              ),
            )
        }),
      ).pipe(Effect.exit)
      yield* Effect.sync(() => {
        watcher.interruptUnsafe()
        attempt.interruptUnsafe()
      })
      if (Exit.isFailure(result) && Cause.hasInterrupts(result.cause)) {
        // External interruption must retain ownership of cooperative cleanup just
        // like the deadline path. Observe both detached fibers within one grace
        // window before allowing the enclosing permit/resource finalizers to run.
        const stopped = yield* Fiber.awaitAll([watcher, attempt]).pipe(
          Effect.timeoutOption(policy.cancellationGraceMs),
        )
        if (Option.isNone(stopped)) {
          const error = escalation("interruption-cleanup")
          // Pending external interruption wins over typed failure at the mask
          // boundary. Publish the handoff before returning to permit finalizers.
          yield* Effect.sync(() => onEscalation(error))
          yield* Effect.logError(
            "Local queue interruption requires supervision",
            error,
          )
          return yield* error
        }
      }
      return yield* result
    }),
  )
})
