/**
 * Configure OpenAuth to use a simple in-memory store.
 *
 * :::caution
 * This is not meant to be used in production.
 * :::
 *
 * This is useful for testing and development. It's not meant to be used in production.
 *
 * ```ts
 * import { MemoryStorageServiceLive } from "@openauthjs/openauth/storage/memory"
 * import { Effect, Layer } from "effect"
 *
 * const app = yield* issuer({ ... }).pipe(
 *   Effect.provide(MemoryStorageServiceLive)
 * )
 * ```
 *
 * @packageDocumentation
 */

import { Clock, Effect, Layer, Stream } from "effect"
import { StorageService, joinKey, splitKey } from "./storage"

/**
 * In-memory storage implementation for OpenAuth.
 * Uses a sorted array with binary search for efficient lookups.
 *
 * Note: Data is not persisted across process restarts.
 * TTL comparisons use Effect's Clock so they work with TestClock.
 */
export const MemoryStorageServiceLive = Layer.sync(StorageService, () => {
  const store: [string, { value: unknown; expiry?: number }][] = []

  function search(key: string) {
    let left = 0
    let right = store.length - 1
    while (left <= right) {
      const mid = Math.floor((left + right) / 2)
      const comparison = key.localeCompare(store[mid]![0])

      if (comparison === 0) {
        return { found: true, index: mid }
      } else if (comparison < 0) {
        right = mid - 1
      } else {
        left = mid + 1
      }
    }
    return { found: false, index: left }
  }

  return {
    get: <T>(key: string[]) =>
      Effect.gen(function* () {
        const match = search(joinKey(key))
        if (!match.found) return undefined
        const entry = store[match.index]![1]
        if (entry.expiry) {
          const nowMs = yield* Clock.currentTimeMillis
          if (nowMs >= entry.expiry) {
            store.splice(match.index, 1)
            return undefined
          }
        }
        return entry.value as T
      }),

    take: <T>(key: string[]) =>
      Effect.gen(function* () {
        const match = search(joinKey(key))
        if (!match.found) return undefined
        const entry = store[match.index]![1]
        store.splice(match.index, 1)
        if (entry.expiry) {
          const nowMs = yield* Clock.currentTimeMillis
          if (nowMs >= entry.expiry) return undefined
        }
        return entry.value as T
      }),

    set: (key: string[], value: unknown, ttl?: number) =>
      Effect.gen(function* () {
        const joined = joinKey(key)
        const match = search(joined)
        const entryValue: { value: unknown; expiry?: number } = { value }
        if (ttl) {
          const nowMs = yield* Clock.currentTimeMillis
          entryValue.expiry = nowMs + ttl * 1000
        }
        const entry: (typeof store)[number] = [joined, entryValue]
        if (!match.found) {
          store.splice(match.index, 0, entry)
        } else {
          store[match.index] = entry
        }
      }),

    remove: (key: string[]) =>
      Effect.sync(() => {
        const joined = joinKey(key)
        const match = search(joined)
        if (match.found) {
          store.splice(match.index, 1)
        }
      }),

    scan: <T>(prefix: string[]) =>
      Stream.fromIterableEffect(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const prefixStr = joinKey(prefix)
          const results: [string[], T][] = []

          for (const [key, entry] of store) {
            if (!key.startsWith(prefixStr)) continue
            if (entry.expiry && now >= entry.expiry) continue
            results.push([splitKey(key), entry.value as T])
          }

          return results
        }),
      ),
  }
})
