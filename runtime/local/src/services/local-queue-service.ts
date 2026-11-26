import {
  EnqueueError,
  type InvalidQueueNameError,
  QueueService,
  validateQueueName,
} from "@processfocus/runtime"
import { Effect, Layer } from "effect"
import { PROCESS_IMPORT_OUTBOX_QUEUE } from "@pf/graphql-db-operations"
import {
  EXECUTION_EVENT_QUEUE,
  FLOW_EXECUTION_QUEUE,
  NOTIFICATION_DELIVERY_QUEUE,
  PROCESS_EVENT_QUEUE,
  SYSTEM_STEP_EXECUTION_QUEUE,
  TODO_EVENT_QUEUE,
} from "@pf/job-handler"
import { PROJECT_ACCOUNTING_QUEUE } from "@pf/project-accounting"
import {
  type SqliteQueueMaintenance,
  SqliteQueueServiceLive,
} from "@pf/sqlite-queue-service"

/** Intended deployment owners, not a live-consumer health check. */
const builtInConsumers: Readonly<Record<string, string>> = {
  [FLOW_EXECUTION_QUEUE]: "local job worker",
  [TODO_EVENT_QUEUE]: "local job worker",
  [PROCESS_EVENT_QUEUE]: "local job worker",
  [PROCESS_IMPORT_OUTBOX_QUEUE]: "local job worker",
  [EXECUTION_EVENT_QUEUE]: "local job worker",
  [SYSTEM_STEP_EXECUTION_QUEUE]: "local job worker",
  [NOTIFICATION_DELIVERY_QUEUE]: "local job worker",
  [PROJECT_ACCOUNTING_QUEUE]: "local GraphQL accounting event publisher",
}

/** Additional queue -> consumer owner declarations must be shared by all producers. */
export const makeLocalQueueServiceLayer = (
  additionalConsumers: unknown,
): Layer.Layer<
  QueueService | SqliteQueueMaintenance,
  EnqueueError | InvalidQueueNameError,
  Layer.Services<typeof SqliteQueueServiceLive>
> =>
  Layer.effect(
    QueueService,
    Effect.gen(function* () {
      const queue = yield* QueueService
      const consumers = new Map(Object.entries(builtInConsumers))
      if (
        typeof additionalConsumers !== "object" ||
        additionalConsumers === null ||
        Array.isArray(additionalConsumers)
      ) {
        return yield* new EnqueueError({
          queue: "configuration",
          message:
            "PF_LOCAL_QUEUE_CONSUMERS must be a JSON object mapping queue names to non-empty consumer owners",
        })
      }
      for (const [name, owner] of Object.entries(additionalConsumers)) {
        yield* validateQueueName(name)
        if (typeof owner !== "string" || owner.trim().length === 0) {
          return yield* new EnqueueError({
            queue: name,
            message: `Declare a non-empty intended consumer owner for queue '${name}' in PF_LOCAL_QUEUE_CONSUMERS`,
          })
        }
        consumers.set(name, owner)
      }
      const admit = (name: string) =>
        Effect.gen(function* () {
          yield* validateQueueName(name)
          if (!consumers.has(name)) {
            return yield* new EnqueueError({
              queue: name,
              message: `No intended consumer declared for queue '${name}'. Configure its custom or separately hosted consumer in PF_LOCAL_QUEUE_CONSUMERS before enqueueing`,
            })
          }
        })
      return QueueService.of({
        ...queue,
        enqueue: (name, payload, options) =>
          admit(name).pipe(
            Effect.andThen(queue.enqueue(name, payload, options)),
          ),
        enqueueWithDelay: (name, payload, delay, options) =>
          admit(name).pipe(
            Effect.andThen(
              queue.enqueueWithDelay(name, payload, delay, options),
            ),
          ),
      })
    }),
  ).pipe(Layer.provideMerge(SqliteQueueServiceLive))

export const LocalQueueServiceLive = Layer.unwrap(
  Effect.try({
    try: (): unknown =>
      JSON.parse(process.env["PF_LOCAL_QUEUE_CONSUMERS"] ?? "{}"),
    catch: () =>
      new EnqueueError({
        queue: "configuration",
        message:
          "PF_LOCAL_QUEUE_CONSUMERS must contain valid JSON mapping queue names to consumer owners",
      }),
  }).pipe(Effect.map(makeLocalQueueServiceLayer)),
)
