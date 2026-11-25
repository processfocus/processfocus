import { Cause, Data, DateTime, Effect } from "effect"
import {
  type SqliteQueueHealth,
  SqliteQueueMaintenance,
} from "@pf/sqlite-queue-service"

export class InvalidQueueObservationPolicy extends Data.TaggedError(
  "InvalidQueueObservationPolicy",
)<{
  readonly message: string
}> {}

export type QueueObservation = {
  readonly sampledAt: string
} & (
  | {
      readonly status: "available"
      readonly queues: readonly SqliteQueueHealth[]
    }
  | { readonly status: "unavailable"; readonly error: string }
)

interface QueueObservationPolicy {
  readonly sampleMs: number
  readonly waitingMs: number
  readonly warningIntervalMs: number
}

export const readQueueObservationPolicy = (
  env: NodeJS.ProcessEnv = process.env,
): Effect.Effect<QueueObservationPolicy, InvalidQueueObservationPolicy> =>
  Effect.gen(function* () {
    const read = (name: string, fallback: number) => {
      const value = env[name] === undefined ? fallback : Number(env[name])
      return Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647
        ? Effect.succeed(value)
        : Effect.fail(
            new InvalidQueueObservationPolicy({
              message: `${name} must be a positive integer <= 2147483647 milliseconds`,
            }),
          )
    }
    return {
      sampleMs: yield* read("PF_LOCAL_QUEUE_SAMPLE_MS", 1000),
      waitingMs: yield* read("PF_LOCAL_QUEUE_WAIT_WARNING_MS", 60_000),
      warningIntervalMs: yield* read(
        "PF_LOCAL_QUEUE_WARNING_INTERVAL_MS",
        60_000,
      ),
    }
  })

/** Runs outside dispatch and, under supervision, outside the execution process. */
export const observeQueueHealth = (
  publish: (observation: QueueObservation) => void,
  env: NodeJS.ProcessEnv = process.env,
): Effect.Effect<
  never,
  InvalidQueueObservationPolicy,
  SqliteQueueMaintenance
> =>
  Effect.gen(function* () {
    const policy = yield* readQueueObservationPolicy(env)
    const maintenance = yield* SqliteQueueMaintenance
    const lastWarnings = new Map<string, number>()
    // Independent maintenance: an unavailable statistics read never blocks recovery.
    // Own it per observation attempt, not per retrying supervisor fiber.
    yield* Effect.forkScoped(
      Effect.forever(
        maintenance.recover().pipe(
          Effect.tap((count) =>
            count > 0
              ? Effect.logWarning("Queue abandoned attempts retired", {
                  count,
                  outcome: "unknown",
                })
              : Effect.void,
          ),
          Effect.catchCause((cause) =>
            Effect.logError("Queue terminal recovery failed", {
              error: Cause.pretty(cause),
            }),
          ),
          Effect.andThen(Effect.sleep(1000)),
        ),
      ),
    )
    return yield* Effect.forever(
      Effect.gen(function* () {
        const now = yield* DateTime.now
        const sampledAt = DateTime.formatIso(now)
        const nowMs = DateTime.toEpochMillis(now)
        yield* maintenance.inspect().pipe(
          Effect.flatMap((queues) =>
            Effect.gen(function* () {
              publish({ status: "available", sampledAt, queues })
              for (const health of queues) {
                const oldest = health.oldestEligible
                if (
                  oldest !== null &&
                  oldest.waitingMs >= policy.waitingMs &&
                  nowMs - (lastWarnings.get(health.queue) ?? -Infinity) >=
                    policy.warningIntervalMs
                ) {
                  lastWarnings.set(health.queue, nowMs)
                  yield* Effect.logWarning(
                    "Local queue eligible work waiting",
                    {
                      queue: health.queue,
                      ...oldest,
                      eligible: health.eligible,
                      thresholdMs: policy.waitingMs,
                    },
                  )
                }
              }
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.sync(() =>
              publish({
                status: "unavailable",
                sampledAt,
                error: Cause.pretty(cause),
              }),
            ),
          ),
        )
        yield* Effect.sleep(policy.sampleMs)
      }),
    )
  }).pipe(Effect.scoped)
