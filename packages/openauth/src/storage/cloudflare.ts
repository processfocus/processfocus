/**
 * Configure OpenAuth to use [Cloudflare KV](https://developers.cloudflare.com/kv/) as a
 * storage adapter.
 *
 * ```ts
 * import { CloudflareStorageServiceLive } from "@openauthjs/openauth/storage/cloudflare"
 * import { Effect, Layer } from "effect"
 *
 * const StorageLayer = CloudflareStorageServiceLive({
 *   namespace: env.MY_KV_NAMESPACE
 * })
 *
 * const app = yield* issuer({ ... }).pipe(
 *   Effect.provide(StorageLayer)
 * )
 * ```
 *
 * @packageDocumentation
 */
import type { KVNamespace } from "@cloudflare/workers-types"
import { Effect, Layer, Schema, Stream } from "effect"
import { StorageError, StorageService, joinKey, splitKey } from "./storage.js"

const JsonValue = Schema.parseJson(Schema.Unknown)

/**
 * Configure the Cloudflare KV store that's created.
 */
export interface CloudflareStorageOptions {
  namespace: KVNamespace
}

/**
 * Creates a Cloudflare KV storage Layer.
 * @param options - The config for the adapter.
 */
export function CloudflareStorageServiceLive(
  options: CloudflareStorageOptions,
): Layer.Layer<StorageService> {
  const mapError = (operation: string) => (error: unknown) =>
    new StorageError({ message: `Cloudflare KV ${operation} failed`, cause: error })

  return Layer.succeed(StorageService, {
    get: <T>(key: string[]) =>
      Effect.tryPromise({
        try: async () => {
          const value = await options.namespace.get(joinKey(key), "json")
          if (!value) return undefined
          return value as T
        },
        catch: mapError("get"),
      }),

    take: <T>(
      _key: string[],
    ): Effect.Effect<T | undefined, StorageError> =>
      Effect.fail(
        new StorageError({
          message: "Cloudflare KV does not support atomic value consumption",
        }),
      ),

    set: (key: string[], value: unknown, ttl?: number) =>
      Effect.gen(function* () {
        const encoded = yield* Schema.encode(JsonValue)(value).pipe(
          Effect.mapError(mapError("put")),
        )

        yield* Effect.tryPromise({
          try: async () => {
          const putOptions: { expirationTtl?: number } = {}
          if (ttl) {
            // Cloudflare KV requires minimum 60 second TTL
            putOptions.expirationTtl = Math.max(ttl, 60)
          }
          await options.namespace.put(
            joinKey(key),
            encoded,
            putOptions,
          )
          },
          catch: mapError("put"),
        })
      }),

    remove: (key: string[]) =>
      Effect.tryPromise({
        try: async () => {
          await options.namespace.delete(joinKey(key))
        },
        catch: mapError("delete"),
      }),

    scan: <T>(prefix: string[]) => {
      return Stream.fromEffect(
        Effect.tryPromise({
          try: async () => {
            const results: [string[], T][] = []
            let cursor: string | undefined

            while (true) {
              const listOptions: { prefix: string; cursor?: string } = {
                prefix: joinKey([...prefix, ""]),
              }
              if (cursor) {
                listOptions.cursor = cursor
              }
              const result = await options.namespace.list(listOptions)

              for (const key of result.keys) {
                const value = await options.namespace.get(key.name, "json")
                if (value !== null) {
                  results.push([splitKey(key.name), value as T])
                }
              }

              if (result.list_complete) {
                break
              }
              cursor = result.cursor
            }

            return results
          },
          catch: mapError("scan"),
        }),
      ).pipe(Stream.flatMap(Stream.fromIterable))
    },
  })
}
