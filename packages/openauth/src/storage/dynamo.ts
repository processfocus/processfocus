/**
 * Configure OpenAuth to use [DynamoDB](https://aws.amazon.com/dynamodb/) as a storage adapter.
 *
 * ```ts
 * import { DynamoStorageServiceLive } from "@openauthjs/openauth/storage/dynamo"
 * import { Effect, Layer } from "effect"
 *
 * const StorageLayer = DynamoStorageServiceLive({
 *   table: "my-table",
 *   pk: "pk",
 *   sk: "sk"
 * })
 *
 * const app = yield* issuer({ ... }).pipe(
 *   Effect.provide(StorageLayer)
 * )
 * ```
 *
 * @packageDocumentation
 */

import { Clock, Effect, Layer, Schema, Stream } from "effect"
import { client } from "./aws"
import { StorageError, StorageService, joinKey } from "./storage"

const JsonValue = Schema.parseJson(Schema.Unknown)

/**
 * Configure the DynamoDB table that's created.
 *
 * @example
 * ```ts
 * {
 *   table: "my-table",
 *   pk: "pk",
 *   sk: "sk"
 * }
 * ```
 */
export interface DynamoStorageOptions {
  /**
   * The name of the DynamoDB table.
   */
  table: string
  /**
   * The primary key column name.
   * @default "pk"
   */
  pk?: string
  /**
   * The sort key column name.
   * @default "sk"
   */
  sk?: string
  /**
   * Endpoint URL for the DynamoDB service. Useful for local testing.
   * @default "https://dynamodb.{region}.amazonaws.com"
   */
  endpoint?: string
  /**
   * The name of the time to live attribute.
   * @default "expiry"
   */
  ttl?: string
}

/**
 * Creates a DynamoDB storage Layer.
 * @param options - The config for the adapter.
 */
export function DynamoStorageServiceLive(
  options: DynamoStorageOptions,
): Layer.Layer<StorageService> {
  const pk = options.pk || "pk"
  const sk = options.sk || "sk"
  const ttlAttr = options.ttl || "expiry"
  const tableName = options.table

  function parseKey(key: string[]) {
    if (key.length === 2) {
      return {
        pk: key[0],
        sk: key[1],
      }
    }
    return {
      pk: joinKey(key.slice(0, 2)),
      sk: joinKey(key.slice(2)),
    }
  }

  async function dynamo(action: string, payload: unknown) {
    const c = await client()
    const endpoint =
      options.endpoint || `https://dynamodb.${c.region}.amazonaws.com`
    const response = await c.fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.0",
        "X-Amz-Target": `DynamoDB_20120810.${action}`,
      },
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      throw new Error(`DynamoDB request failed: ${response.statusText}`)
    }

    return response.json() as Promise<Record<string, unknown>>
  }

  const mapStorageError = (message: string) => (cause: unknown) =>
    new StorageError({ message, cause })

  return Layer.succeed(StorageService, {
    get: <T>(key: string[]) =>
      Effect.gen(function* () {
        const { pk: keyPk, sk: keySk } = parseKey(key)
        const params = {
          TableName: tableName,
          Key: {
            [pk]: { S: keyPk },
            [sk]: { S: keySk },
          },
        }
        const result = (yield* Effect.tryPromise({
          try: () => dynamo("GetItem", params),
          catch: mapStorageError("DynamoDB get failed"),
        })) as { Item?: Record<string, { S?: string; N?: string }> }
        if (!result.Item) return undefined
        const ttlValue = result.Item[ttlAttr]
        if (ttlValue?.N) {
          const nowSeconds = (yield* Clock.currentTimeMillis) / 1000
          if (Number(ttlValue.N) < nowSeconds) {
            return undefined
          }
        }
        const valueStr = result.Item["value"]?.S
        if (!valueStr) return undefined
        return (yield* Schema.decodeUnknown(JsonValue)(valueStr).pipe(
          Effect.mapError(mapStorageError("DynamoDB get decode failed")),
        )) as T
      }),

    take: <T>(key: string[]) =>
      Effect.gen(function* () {
        const { pk: keyPk, sk: keySk } = parseKey(key)
        const params = {
          TableName: tableName,
          Key: {
            [pk]: { S: keyPk },
            [sk]: { S: keySk },
          },
          ReturnValues: "ALL_OLD",
        }
        const result = (yield* Effect.tryPromise({
          try: () => dynamo("DeleteItem", params),
          catch: mapStorageError("DynamoDB take failed"),
        })) as { Attributes?: Record<string, { S?: string; N?: string }> }
        if (!result.Attributes) return undefined
        const ttlValue = result.Attributes[ttlAttr]
        if (ttlValue?.N) {
          const nowSeconds = (yield* Clock.currentTimeMillis) / 1000
          if (Number(ttlValue.N) <= nowSeconds) {
            return undefined
          }
        }
        const valueStr = result.Attributes["value"]?.S
        if (!valueStr) return undefined
        return (yield* Schema.decodeUnknown(JsonValue)(valueStr).pipe(
          Effect.mapError(mapStorageError("DynamoDB take decode failed")),
        )) as T
      }),

    set: (key: string[], value: unknown, ttl?: number) =>
      Effect.gen(function* () {
        const parsed = parseKey(key)
        const encoded = yield* Schema.encode(JsonValue)(value).pipe(
          Effect.mapError(mapStorageError("DynamoDB set encode failed")),
        )
        const item: Record<string, { S: string } | { N: string }> = {
          [pk]: { S: parsed.pk ?? "" },
          [sk]: { S: parsed.sk ?? "" },
          value: { S: encoded },
        }
        if (ttl) {
          const nowMs = yield* Clock.currentTimeMillis
          item[ttlAttr] = {
            N: Math.floor((nowMs + ttl * 1000) / 1000).toString(),
          }
        }
        const params = {
          TableName: tableName,
          Item: item,
        }
        yield* Effect.tryPromise({
          try: () => dynamo("PutItem", params),
          catch: mapStorageError("DynamoDB put failed"),
        })
      }),

    remove: (key: string[]) =>
      Effect.gen(function* () {
        const { pk: keyPk, sk: keySk } = parseKey(key)
        const params = {
          TableName: tableName,
          Key: {
            [pk]: { S: keyPk },
            [sk]: { S: keySk },
          },
        }
        yield* Effect.tryPromise({
          try: () => dynamo("DeleteItem", params),
          catch: mapStorageError("DynamoDB remove failed"),
        })
      }),

    scan: <T>(prefix: string[]) => {
      const prefixPk =
        prefix.length >= 2 ? joinKey(prefix.slice(0, 2)) : prefix[0]
      const prefixSk = prefix.length > 2 ? joinKey(prefix.slice(2)) : ""

      return Stream.fromEffect(
        Effect.gen(function* () {
          const results: [string[], T][] = []
          let lastEvaluatedKey: unknown
          const now = (yield* Clock.currentTimeMillis) / 1000

          while (true) {
            const params: Record<string, unknown> = {
              TableName: tableName,
              KeyConditionExpression: prefixSk
                ? `#pk = :pk AND begins_with(#sk, :sk)`
                : `#pk = :pk`,
              ExpressionAttributeNames: {
                "#pk": pk,
                ...(prefixSk && { "#sk": sk }),
              },
              ExpressionAttributeValues: {
                ":pk": { S: prefixPk },
                ...(prefixSk && { ":sk": { S: prefixSk } }),
              },
            }
            if (lastEvaluatedKey) {
              params["ExclusiveStartKey"] = lastEvaluatedKey
            }

            const result = (yield* Effect.tryPromise({
              try: () => dynamo("Query", params),
              catch: mapStorageError("DynamoDB scan failed"),
            })) as {
              Items?: Record<string, { S?: string; N?: string }>[]
              LastEvaluatedKey?: unknown
            }

            for (const item of result.Items ?? []) {
              const ttlValue = item[ttlAttr]
              if (ttlValue?.N && Number(ttlValue.N) < now) {
                continue
              }
              const pkValue = item[pk]?.S
              const skValue = item[sk]?.S
              const valueStr = item["value"]?.S
              if (pkValue && skValue && valueStr) {
                const decoded = (yield* Schema.decodeUnknown(JsonValue)(
                  valueStr,
                ).pipe(
                  Effect.mapError(mapStorageError("DynamoDB scan decode failed")),
                )) as T
                results.push([
                  [pkValue, skValue],
                  decoded,
                ])
              }
            }

            if (!result.LastEvaluatedKey) break
            lastEvaluatedKey = result.LastEvaluatedKey
          }

          return results
        }),
      ).pipe(Stream.flatMap(Stream.fromIterable))
    },
  })
}
