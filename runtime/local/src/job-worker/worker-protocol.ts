import { Effect, Schema } from "effect"

export const WorkerMessage = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["starting", "heartbeat", "claim", "idle"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("ready"),
    pid: Schema.Number,
    instance: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("attempt"),
    jobId: Schema.String,
    receipt: Schema.String,
    queue: Schema.String,
    startedAt: Schema.String,
    executionDeadline: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("state"),
    state: Schema.Struct({
      activeJobs: Schema.Number,
      paused: Schema.Boolean,
      pauseToken: Schema.NullOr(Schema.String),
      updatedAt: Schema.String,
      escalation: Schema.optional(Schema.Unknown),
      longestAttempt: Schema.optional(Schema.Unknown),
    }),
  }),
])

export type WorkerMessage = typeof WorkerMessage.Type

// This transport is only present in the isolated worker. Embedded pollers retain
// their existing callback/state-file interface. Loss of the supervisor is fatal:
// an orphan must not continue claiming beside a replacement.
const reportToSupervisor = (message: WorkerMessage): void => {
  if (process.send) process.send(message)
}

export const reportWorkerActivity = (
  message: WorkerMessage,
): Effect.Effect<void> => Effect.sync(() => reportToSupervisor(message))

export const startWorkerHeartbeat = (): void => {
  if (!process.send) return
  reportToSupervisor({ kind: "starting" })
  process.on("disconnect", () => process.exit(1))
  setInterval(() => reportToSupervisor({ kind: "heartbeat" }), 100).unref()
}
