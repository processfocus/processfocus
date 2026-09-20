import { Context, Effect, ManagedRuntime } from "effect"
import { buildSchema } from "graphql"
import { type EventHubService, createEventHubLayer } from "./event-hub"
import { describe, expect, it } from "bun:test"

class Events extends Context.Tag("event-hub-test")<
  Events,
  EventHubService<number>
>() {}

const schema = buildSchema("type Query { value: Int }")

describe("local event hub cancellation", () => {
  it("return interrupts an empty pending take without affecting independent subscribers or reconnects", async () => {
    const runtime = ManagedRuntime.make(createEventHubLayer(Events))
    try {
      const hub = await runtime.runPromise(Events)
      const first = (await runtime.runPromise(hub.subscribe()))[
        Symbol.asyncIterator
      ]()
      const second = (await runtime.runPromise(hub.subscribe()))[
        Symbol.asyncIterator
      ]()
      const pending = first.next()
      expect(await first.return?.()).toEqual({ done: true, value: undefined })
      expect(await pending).toEqual({ done: true, value: undefined })
      expect(await first.next()).toEqual({ done: true, value: undefined })
      const reconnect = (await runtime.runPromise(hub.subscribe()))[
        Symbol.asyncIterator
      ]()
      await runtime.runPromise(hub.emit(42, schema))
      expect(await second.next()).toEqual({ done: false, value: 42 })
      expect(await reconnect.next()).toEqual({ done: false, value: 42 })
      await second.return?.()
      await reconnect.return?.()
      await runtime.runPromise(hub.emit(43, schema))
    } finally {
      await runtime.dispose()
    }
  })

  it("throw interrupts pending take and return is safe before the first read", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const hub = yield* Events
        const source = (yield* hub.subscribe())[Symbol.asyncIterator]()
        yield* Effect.promise(async () => {
          const pending = source.next()
          const error = new Error("cancelled")
          await expect(source.throw?.(error)).rejects.toBe(error)
          expect(await pending).toEqual({ done: true, value: undefined })
          await source.return?.()
        })
        const unused = (yield* hub.subscribe())[Symbol.asyncIterator]()
        yield* Effect.promise(async () => {
          await unused.return?.()
          expect(await unused.next()).toEqual({ done: true, value: undefined })
        })
      }).pipe(Effect.provide(createEventHubLayer(Events))),
    )
  })
})
