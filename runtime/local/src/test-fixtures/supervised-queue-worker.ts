import { appendFileSync } from "node:fs"
import { QueueService } from "@processfocus/runtime"
import { Effect, Schema, Semaphore } from "effect"
import { createSingleQueuePoller } from "../job-worker/queue-poller"
import { jobHandler } from "../job-worker/types"
import { startWorkerHeartbeat } from "../job-worker/worker-protocol"
import { supervisedQueueLayer } from "../test-support/supervised-queue"

startWorkerHeartbeat()
const path = process.argv[2]
if (!path) throw new Error("Queue fixture needs a database path")
const scenario = process.env["QUEUE_SCENARIO"]
const events = `${path}.events`
await Effect.runPromise(
  Effect.gen(function* () {
    const queue = yield* QueueService
    const wedged = Effect.uninterruptible(Effect.never)
    const handlers = {
      work: jobHandler({
        schema: Schema.Struct({ name: Schema.String }),
        handle: (job) =>
          Effect.gen(function* () {
            appendFileSync(
              events,
              `${JSON.stringify({ name: job.payload.name, attempt: job.attempts, receipt: job.receipt, pid: process.pid })}\n`,
            )
            if (job.payload.name === "bad" && job.attempts === 1) {
              if (scenario === "blocking")
                yield* Effect.sync(() => {
                  while (true) {
                    /* block the actual execution thread */
                  }
                })
              else if (scenario === "cleanup")
                yield* Effect.never.pipe(Effect.ensuring(wedged))
              else if (scenario === "ack") return
              else yield* wedged
            }
          }),
      }),
    }
    return yield* createSingleQueuePoller(
      handlers,
      yield* Semaphore.make(1),
    ).pipe(
      Effect.provideService(
        QueueService,
        scenario === "ack"
          ? {
              ...queue,
              acknowledge: (id, receipt) =>
                id === "bad" ? wedged : queue.acknowledge(id, receipt),
            }
          : queue,
      ),
    )
  }).pipe(Effect.provide(supervisedQueueLayer(path))),
)
