import { Effect, Stream, TestClock, TestContext } from "effect"
import { MemoryStorageServiceLive } from "../src/storage/memory.js"
import { Storage, type StorageError, type StorageService } from "../src/storage/storage.js"
import { describe, expect, test } from "bun:test"

// Helper to run storage effects with MemoryStorageServiceLive
const runStorage = <T>(
  effect: Effect.Effect<T, StorageError, StorageService>,
): Promise<T> =>
  Effect.runPromise(effect.pipe(Effect.provide(MemoryStorageServiceLive)))

// Helper that provides TestClock so TTL can be advanced without real time
const runStorageWithTestClock = <T>(
  effect: Effect.Effect<T, StorageError, StorageService>,
): Promise<T> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(MemoryStorageServiceLive),
      Effect.provide(TestContext.TestContext),
    ),
  )

describe("set", () => {
  test("basic", async () => {
    await runStorage(
      Effect.gen(function* () {
        yield* Storage.set(["users", "123"], { name: "Test User" })
        const result = yield* Storage.get(["users", "123"])
        expect(result).toEqual({ name: "Test User" })
      }),
    )
  })

  test("ttl", async () => {
    await runStorageWithTestClock(
      Effect.gen(function* () {
        yield* Storage.set(["temp", "key"], { value: "value" }, 1) // 1 second TTL
        const result = yield* Storage.get<{ value: string }>(["temp", "key"])
        expect(result?.value).toBe("value")

        yield* TestClock.adjust("1 second")
        const result2 = yield* Storage.get<{ value: string }>(["temp", "key"])
        expect(result2).toBeUndefined()
      }),
    )
  })

  test("nested", async () => {
    await runStorage(
      Effect.gen(function* () {
        const complexObj = {
          id: 1,
          nested: { a: 1, b: { c: 2 } },
          array: [1, 2, 3],
        }
        yield* Storage.set(["complex"], complexObj)
        const result = yield* Storage.get(["complex"])
        expect(result).toEqual(complexObj)
      }),
    )
  })
})

describe("get", () => {
  test("missing", async () => {
    await runStorage(
      Effect.gen(function* () {
        const result = yield* Storage.get(["nonexistent"])
        expect(result).toBeUndefined()
      }),
    )
  })

  test("key", async () => {
    await runStorage(
      Effect.gen(function* () {
        yield* Storage.set(["a", "b", "c"], { value: "nested" })
        const result = yield* Storage.get<{ value: string }>(["a", "b", "c"])
        expect(result?.value).toBe("nested")
      }),
    )
  })
})

describe("take", () => {
  test("returns a value only once", async () => {
    await runStorage(
      Effect.gen(function* () {
        yield* Storage.set(["single-use"], { value: "secret" })
        const first = yield* Storage.take<{ value: string }>(["single-use"])
        const second = yield* Storage.take<{ value: string }>(["single-use"])

        expect(first).toEqual({ value: "secret" })
        expect(second).toBeUndefined()
      }),
    )
  })

  test("does not return an expired value", async () => {
    await runStorageWithTestClock(
      Effect.gen(function* () {
        yield* Storage.set(["expired"], "value", 1)
        yield* TestClock.adjust("1 second")

        expect(yield* Storage.take(["expired"])).toBeUndefined()
        expect(yield* Storage.get(["expired"])).toBeUndefined()
      }),
    )
  })

  test("atomically serves concurrent consumers", async () => {
    await runStorage(
      Effect.gen(function* () {
        yield* Storage.set(["contended"], "value")
        const results = yield* Effect.all(
          [Storage.take<string>(["contended"]), Storage.take<string>(["contended"])],
          { concurrency: "unbounded" },
        )

        expect(results.filter((value) => value === "value")).toHaveLength(1)
        expect(results.filter((value) => value === undefined)).toHaveLength(1)
      }),
    )
  })
})

describe("remove", () => {
  test("existing", async () => {
    await runStorage(
      Effect.gen(function* () {
        yield* Storage.set(["test"], "value")
        yield* Storage.remove(["test"])
        const result = yield* Storage.get(["test"])
        expect(result).toBeUndefined()
      }),
    )
  })

  test("missing", async () => {
    await runStorage(Storage.remove(["nonexistent"]))
  })
})

describe("scan", () => {
  test("all", async () => {
    await runStorage(
      Effect.gen(function* () {
        yield* Storage.set(["users", "1"], { id: 1 })
        yield* Storage.set(["users", "2"], { id: 2 })
        yield* Storage.set(["other"], { id: 3 })
        const results: [string[], { id: number }][] = []
        yield* Storage.scan<{ id: number }>(["users"]).pipe(
          Stream.runForEach(([key, value]) =>
            Effect.sync(() => {
              results.push([key, value])
            }),
          ),
        )
        expect(results).toHaveLength(2)
        expect(results).toContainEqual([["users", "1"], { id: 1 }])
        expect(results).toContainEqual([["users", "2"], { id: 2 }])
      }),
    )
  })

  test("ttl", async () => {
    await runStorageWithTestClock(
      Effect.gen(function* () {
        yield* Storage.set(["temp", "1"], "a", 1)
        yield* Storage.set(["temp", "2"], "b", 1)
        yield* Storage.set(["temp", "3"], "c")

        const results1: unknown[] = []
        yield* Storage.scan(["temp"]).pipe(
          Stream.runForEach(([, value]) =>
            Effect.sync(() => {
              results1.push(value)
            }),
          ),
        )
        expect(results1).toHaveLength(3)

        yield* TestClock.adjust("1 second")
        const results2: unknown[] = []
        yield* Storage.scan(["temp"]).pipe(
          Stream.runForEach(([, value]) =>
            Effect.sync(() => {
              results2.push(value)
            }),
          ),
        )
        expect(results2).toHaveLength(1)
      }),
    )
  })
})
