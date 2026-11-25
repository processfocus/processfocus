import { Cause, type Context, Effect, Layer, Queue } from "effect"
import type { GraphQLSchema } from "graphql"

const DEFAULT_BUFFER_SIZE = 32

/**
 * Shape shared by the local in-memory event-hub services (process, execution,
 * todo, draft-process).
 *
 * `EmitError` defaults to `never` (local hubs do not fail). TodoEvents uses
 * `unknown` so AWS AppSync failures can surface for job-worker retries; the
 * local implementation remains infallible and is still assignable.
 */
export type EventHubService<
  Event,
  SubscribeError = never,
  EmitError = never,
> = {
  readonly emit: (
    event: Event,
    schema: GraphQLSchema,
  ) => Effect.Effect<void, EmitError, never>
  readonly subscribe: () => Effect.Effect<AsyncIterable<Event>, SubscribeError>
}

export type CreateEventHubLayerOptions = {
  readonly bufferSize?: number
}

/**
 * Live in-memory event broadcasting layer.
 *
 * Can only handle as many subscribers as memory allows, and subscribers must
 * resubscribe on restart. For the local-runtime use case that is sufficient.
 *
 * @param tag - Context tag for the event service
 * @param options.bufferSize - Sliding queue capacity per subscriber (default 32)
 */
export const createEventHubLayer = <
  I,
  Event,
  SubscribeError = never,
  EmitError = never,
>(
  tag: Context.Service<I, EventHubService<Event, SubscribeError, EmitError>>,
  options: CreateEventHubLayerOptions = {},
): Layer.Layer<I> => {
  const bufferSize = options.bufferSize ?? DEFAULT_BUFFER_SIZE

  return Layer.effect(tag, createEventHub<Event>(bufferSize))
}

/** Shared local hub without a GraphQL transport dependency. */
export const createEventHub = <Event>(
  bufferSize = DEFAULT_BUFFER_SIZE,
): Effect.Effect<{
  readonly emit: (event: Event) => Effect.Effect<void>
  readonly subscribe: (
    accepts?: (event: Event) => boolean,
  ) => Effect.Effect<AsyncIterableIterator<Event>>
}> =>
  Effect.sync(() => {
    const subscribers = new Map<Queue.Queue<Event>, (event: Event) => boolean>()

    return {
      emit: (event: Event) =>
        // Broadcast to all active subscribers.
        // Note: schema is unused in local runtime - it's needed by AWS
        // runtime for AppSync Events serialization.
        Effect.forEach(
          Array.from(subscribers).filter(([, accepts]) => accepts(event)),
          ([queue]) => Queue.offer(queue, event),
          { discard: true },
        ),

      subscribe: (accepts: (event: Event) => boolean = () => true) =>
        Effect.gen(function* () {
          const queue = yield* Queue.sliding<Event>(bufferSize)
          subscribers.set(queue, accepts)

          // Capture -propagating runtime for the async iterator.
          const runtime = yield* Effect.context<never>()
          const run = Effect.runPromiseWith(runtime)
          let closed = false
          const close = async () => {
            closed = true
            subscribers.delete(queue)
            await run(Queue.shutdown(queue))
          }

          const iterator: AsyncIterableIterator<Event> = {
            [Symbol.asyncIterator]() {
              return this
            },
            async next(): Promise<IteratorResult<Event>> {
              if (closed) return { done: true, value: undefined }
              try {
                const event = await run(Queue.take(queue))
                return closed
                  ? { done: true, value: undefined }
                  : { done: false, value: event }
              } catch (error) {
                if (closed) return { done: true, value: undefined }
                // Best-effort structured log; never mask the original failure.
                try {
                  await run(
                    Effect.logError("Subscriber queue error", Cause.die(error)),
                  )
                } catch {
                  // ignore logging failures
                }
                await close()
                throw error
              }
            },
            async return(): Promise<IteratorResult<Event>> {
              // Async-generator return waits behind next; shutdown must interrupt take.
              await close()
              return { done: true, value: undefined }
            },
            async throw(error: unknown): Promise<IteratorResult<Event>> {
              await close()
              throw error
            },
          }
          return iterator
        }),
    }
  })
