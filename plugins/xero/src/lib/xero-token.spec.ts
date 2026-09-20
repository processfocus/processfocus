import { Deferred, Effect, Either, Fiber, Redacted, Ref } from "effect"
import { xeroAuthError } from "./errors"
import { type XeroAccess, makeXeroAccessCache } from "./xero-token"
import { describe, expect, it } from "bun:test"

const sampleAccess = (sequence: number): XeroAccess => ({
  accessToken: Redacted.make(`token-${String(sequence)}`),
  tenantId: "11111111-1111-4111-8111-111111111111",
  refreshAfterMs: Number.MAX_SAFE_INTEGER,
})

describe("Xero access token cache", () => {
  it("does not poison the cache after an interrupted first refresh", async () => {
    const access = await Effect.runPromise(
      Effect.gen(function* () {
        const fetches = yield* Ref.make(0)
        const firstStarted = yield* Deferred.make<void>()
        const cache = yield* makeXeroAccessCache(
          Effect.gen(function* () {
            const n = yield* Ref.updateAndGet(fetches, (count) => count + 1)
            if (n === 1) {
              yield* Deferred.succeed(firstStarted, undefined)
              return yield* Effect.never
            }
            return sampleAccess(n)
          }),
        )

        const owner = yield* Effect.fork(cache.get())
        yield* Deferred.await(firstStarted)
        yield* Fiber.interrupt(owner)
        return yield* cache.get()
      }),
    )

    expect(Redacted.value(access.accessToken)).toBe("token-2")
  })

  it("interrupted owner does not cancel concurrent joiners", async () => {
    const [first, second] = await Effect.runPromise(
      Effect.gen(function* () {
        const fetches = yield* Ref.make(0)
        const firstStarted = yield* Deferred.make<void>()
        const cache = yield* makeXeroAccessCache(
          Effect.gen(function* () {
            const n = yield* Ref.updateAndGet(fetches, (count) => count + 1)
            if (n === 1) {
              yield* Deferred.succeed(firstStarted, undefined)
              return yield* Effect.never
            }
            return sampleAccess(n)
          }),
        )

        const owner = yield* Effect.fork(cache.get())
        yield* Deferred.await(firstStarted)
        const waiterA = yield* Effect.fork(cache.get())
        const waiterB = yield* Effect.fork(cache.get())
        yield* Effect.yieldNow()
        yield* Fiber.interrupt(owner)
        return yield* Effect.all([Fiber.join(waiterA), Fiber.join(waiterB)], {
          concurrency: 2,
        })
      }),
    )

    expect(Redacted.value(first.accessToken)).toBe("token-2")
    expect(Redacted.value(second.accessToken)).toBe("token-2")
  })

  it("clears a typed refresh failure so the next get fetches again", async () => {
    const access = await Effect.runPromise(
      Effect.gen(function* () {
        const fetches = yield* Ref.make(0)
        const cache = yield* makeXeroAccessCache(
          Effect.gen(function* () {
            const n = yield* Ref.updateAndGet(fetches, (count) => count + 1)
            if (n === 1) {
              return yield* xeroAuthError(
                "Xero Custom Connection authentication failed",
              )
            }
            return sampleAccess(n)
          }),
        )

        const first = yield* cache.get().pipe(Effect.either)
        expect(Either.isLeft(first)).toBe(true)
        if (Either.isRight(first)) {
          throw new Error("expected auth failure")
        }
        expect(first.left.code).toBe("auth")
        expect(first.left.retryable).toBe(false)

        return yield* cache.get()
      }),
    )

    expect(Redacted.value(access.accessToken)).toBe("token-2")
  })
})
