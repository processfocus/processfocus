import "server-only"
import { randomUUID } from "node:crypto"
import { DynamoDB } from "@effect-aws/client-dynamodb"
import { Effect, ManagedRuntime, Schema } from "effect"

type DdbItem = NonNullable<
  Effect.Success<ReturnType<DynamoDB.Type["getItem"]>>["Item"]
>
type Stored = { revision: string; expires: number | undefined; json: string }
type RecordVersion<T> = { revision: string; value: T }

const live = ManagedRuntime.make(DynamoDB.defaultLayer)
// Next bundles the callback and MCP route separately. They share process state
// only in local mode; every deployed read/write goes through DynamoDB.
const local: typeof globalThis & {
  pfMcpRecords?: Map<string, Map<string, Stored>>
} = globalThis

type Bucket<T> = {
  get(id: string): Promise<RecordVersion<T> | undefined>
  entries(): AsyncIterable<RecordVersion<T>>
  put(
    id: string,
    value: T,
    expires?: number,
    previous?: RecordVersion<T>,
  ): Promise<RecordVersion<T> | undefined>
  remove(id: string, previous: RecordVersion<T>): Promise<boolean>
}

export function bucket<T>(
  origin: string,
  kind: string,
  schema: Schema.Decoder<T>,
): Bucket<T> {
  const partition = `${origin}#${kind}`
  const decode = Schema.decodeUnknownSync(Schema.fromJsonString(schema))
  const parse = (record: Stored): RecordVersion<T> | undefined =>
    record.expires !== undefined && record.expires <= Date.now()
      ? undefined
      : { revision: record.revision, value: decode(record.json) }
  if (process.env["PF_RUNTIME_MODE"] !== "deployed") {
    local.pfMcpRecords ??= new Map()
    const records = local.pfMcpRecords
    const data = records.get(partition) ?? new Map<string, Stored>()
    records.set(partition, data)
    const prune = () => {
      for (const [id, value] of data) {
        if (value.expires !== undefined && value.expires <= Date.now())
          data.delete(id)
      }
    }
    return {
      get: async (id) => {
        const value = data.get(id)
        return value ? parse(value) : undefined
      },
      async *entries() {
        prune()
        for (const value of data.values()) {
          const record = parse(value)
          if (record) yield record
        }
      },
      put: async (id, value, expires, previous) => {
        prune()
        if (data.get(id)?.revision !== previous?.revision) return undefined
        const revision = randomUUID()
        data.set(id, { revision, expires, json: JSON.stringify(value) })
        return { revision, value }
      },
      remove: async (id, previous) => {
        prune()
        if (data.get(id)?.revision !== previous.revision) return false
        return data.delete(id)
      },
    }
  }

  const TableName = process.env["PF_MCP_TABLE"]
  if (!TableName) throw new Error("Hosted MCP storage is not configured")
  const keys = { pk: { S: partition } }
  const key = (id: string) => ({ ...keys, sk: { S: id } })
  const read = (item: DdbItem) => {
    const revision = item["revision"]?.S
    const json = item["json"]?.S
    const expires = item["expires"]?.N
    if (!revision || !json) throw new Error("Invalid MCP storage record")
    return parse({
      revision,
      json,
      expires: expires === undefined ? undefined : Number(expires),
    })
  }
  return {
    get: (id) =>
      live.runPromise(
        Effect.gen(function* () {
          const db = yield* DynamoDB
          const { Item } = yield* db.getItem({
            TableName,
            Key: key(id),
            ConsistentRead: true,
          })
          return Item ? read(Item) : undefined
        }),
      ),
    async *entries() {
      let cursor: Parameters<DynamoDB.Type["query"]>[0]["ExclusiveStartKey"]
      do {
        const { Items, LastEvaluatedKey } = await live.runPromise(
          Effect.gen(function* () {
            const db = yield* DynamoDB
            return yield* db.query({
              TableName,
              KeyConditionExpression: "pk = :partition",
              ExpressionAttributeValues: { ":partition": keys.pk },
              ExclusiveStartKey: cursor,
              ConsistentRead: true,
            })
          }),
        )
        for (const item of Items ?? []) {
          const record = read(item)
          if (record) yield record
        }
        cursor = LastEvaluatedKey
      } while (cursor)
    },
    put: (id, value, expires, previous) =>
      live.runPromise(
        Effect.gen(function* () {
          const db = yield* DynamoDB
          const revision = randomUUID()
          return yield* db
            .putItem({
              TableName,
              Item: {
                ...key(id),
                revision: { S: revision },
                json: { S: JSON.stringify(value) },
                ...(expires === undefined
                  ? {}
                  : {
                      expires: { N: String(expires) },
                      ttl: { N: String(Math.ceil(expires / 1000)) },
                    }),
              },
              ConditionExpression: previous
                ? "revision = :revision AND (attribute_not_exists(expires) OR expires > :now)"
                : "attribute_not_exists(pk)",
              ...(previous
                ? {
                    ExpressionAttributeValues: {
                      ":revision": { S: previous.revision },
                      ":now": { N: String(Date.now()) },
                    },
                  }
                : {}),
            })
            .pipe(
              Effect.as({ revision, value }),
              Effect.catchTag("ConditionalCheckFailedException", () =>
                Effect.succeed(undefined),
              ),
            )
        }),
      ),
    remove: (id, previous) =>
      live.runPromise(
        Effect.gen(function* () {
          const db = yield* DynamoDB
          return yield* db
            .deleteItem({
              TableName,
              Key: key(id),
              ConditionExpression:
                "revision = :revision AND (attribute_not_exists(expires) OR expires > :now)",
              ExpressionAttributeValues: {
                ":revision": { S: previous.revision },
                ":now": { N: String(Date.now()) },
              },
            })
            .pipe(
              Effect.as(true),
              Effect.catchTag("ConditionalCheckFailedException", () =>
                Effect.succeed(false),
              ),
            )
        }),
      ),
  }
}
