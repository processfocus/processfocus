import { Context, Data, Effect, Stream } from "effect"

const SEPARATOR = String.fromCharCode(0x1f)

export function joinKey(key: string[]) {
  return key.join(SEPARATOR)
}

export function splitKey(key: string) {
  return key.split(SEPARATOR)
}

/**
 * Encode key parts by removing separator characters.
 */
function encodeKey(key: string[]) {
  return key.map((k) => k.replaceAll(SEPARATOR, ""))
}

/**
 * Storage error that wraps underlying implementation errors.
 */
export class StorageError extends Data.TaggedError("@pf/openauth/StorageError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Effect-based storage service for OpenAuth.
 *
 * Provides key-value storage with TTL support and prefix scanning.
 * Implementations should handle expiry/TTL at the storage level.
 */
export class StorageService extends Context.Tag("@pf/openauth/StorageService")<
  StorageService,
  {
    /**
     * Get a value by key. Returns undefined if not found or expired.
     */
    readonly get: <T>(key: string[]) => Effect.Effect<T | undefined, StorageError>
    /**
     * Get and remove a value by key. Implementations should make this atomic where supported.
     * Returns undefined if not found or expired.
     */
    readonly take: <T>(key: string[]) => Effect.Effect<T | undefined, StorageError>
    /**
     * Set a value with optional TTL in seconds.
     */
    readonly set: (key: string[], value: unknown, ttl?: number) => Effect.Effect<void, StorageError>
    /**
     * Remove a value by key.
     */
    readonly remove: (key: string[]) => Effect.Effect<void, StorageError>
    /**
     * Scan all values with the given prefix.
     * Returns a stream of [key, value] pairs.
     */
    readonly scan: <T>(prefix: string[]) => Stream.Stream<[string[], T], StorageError>
  }
>() {}

/**
 * Helper namespace for common storage operations with key encoding.
 */
export namespace Storage {
  export const get = <T>(key: string[]): Effect.Effect<T | undefined, StorageError, StorageService> =>
    Effect.gen(function* () {
      const storage = yield* StorageService
      return yield* storage.get<T>(encodeKey(key))
    })

  export const take = <T>(key: string[]): Effect.Effect<T | undefined, StorageError, StorageService> =>
    Effect.gen(function* () {
      const storage = yield* StorageService
      return yield* storage.take<T>(encodeKey(key))
    })

  export const set = (
    key: string[],
    value: unknown,
    ttl?: number,
  ): Effect.Effect<void, StorageError, StorageService> =>
    Effect.gen(function* () {
      const storage = yield* StorageService
      return yield* storage.set(encodeKey(key), value, ttl)
    })

  export const remove = (key: string[]): Effect.Effect<void, StorageError, StorageService> =>
    Effect.gen(function* () {
      const storage = yield* StorageService
      return yield* storage.remove(encodeKey(key))
    })

  export const scan = <T>(prefix: string[]): Stream.Stream<[string[], T], StorageError, StorageService> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const storage = yield* StorageService
        return storage.scan<T>(encodeKey(prefix))
      }),
    )
}
