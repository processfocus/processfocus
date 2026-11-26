import { QueueService } from "@processfocus/runtime"
import { Effect, Layer, Option, Schedule } from "effect"
import {
  PROJECT_ACCOUNTING_QUEUE,
  ProjectAccountingChange,
  ProjectAccountingEvents,
} from "@pf/project-accounting"
import { createEventHub } from "./event-hub"

/** Only the local GraphQL process consumes this queue, beside its event hub. */
export const ProjectAccountingEventsLive = Layer.effect(
  ProjectAccountingEvents,
  Effect.gen(function* () {
    const queue = yield* QueueService
    const hub = yield* createEventHub<ProjectAccountingChange>()
    const dispatch = Effect.gen(function* () {
      const claimed = yield* QueueService.claim(
        PROJECT_ACCOUNTING_QUEUE,
        ProjectAccountingChange,
      )
      if (Option.isNone(claimed)) return
      const job = claimed.value
      yield* hub.emit(job.payload)
      yield* queue.acknowledge(job.jobId, job.receipt)
    })
    // An interrupted/failed publication leaves the intent leased, then reclaimable.
    yield* dispatch.pipe(
      Effect.catchCause(Effect.logError),
      Effect.repeat(Schedule.spaced("250 millis")),
      Effect.forkScoped,
    )
    return {
      emit: hub.emit,
      subscribe: (projectId, recipientPrincipalId, environmentId) =>
        hub.subscribe((event) => {
          if ("recipientPrincipalId" in event)
            return event.recipientPrincipalId === recipientPrincipalId
          if ("deployment" in event)
            return (
              event.deployment.projectId === projectId &&
              event.deployment.environmentId === environmentId
            )
          return environmentId === undefined && event.projectId === projectId
        }),
    }
  }),
)
