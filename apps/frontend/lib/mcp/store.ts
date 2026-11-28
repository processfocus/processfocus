import "server-only"
import { createHmac } from "node:crypto"
import { Option, Schema } from "effect"
import { getGraphqlEndpoint } from "@/lib/graphql/endpoint"

const path = "/internal/mcp-oauth"
const Stored = Schema.Struct({
  key: Schema.String,
  revision: Schema.String,
  value: Schema.Unknown,
})
const MaybeRecord = Schema.NullOr(Stored)
const RecordPage = Schema.Array(Stored)

type RecordVersion<T> = { revision: string; value: T }
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

async function request<A>(
  schema: Schema.Decoder<A>,
  operation: Record<string, unknown>,
): Promise<A> {
  const deployed = process.env["PF_RUNTIME_MODE"] === "deployed"
  const base = deployed
    ? process.env["PF_MCP_STORAGE_ORIGIN"]
    : getGraphqlEndpoint()
  const secret = deployed
    ? process.env["PUBLIC_TODO_TOKEN_SECRET"]
    : process.env["PF_MCP_STORAGE_SECRET"]
  if (!base || !secret) throw new Error("MCP OAuth storage is not configured")
  const authorization = createHmac("sha256", secret)
    .update(path)
    .digest("base64url")
  const response = await fetch(new URL(path, base), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authorization}`,
    },
    cache: "no-store",
    redirect: "error",
    body: JSON.stringify(operation),
  }).catch(() => undefined)
  if (!response?.ok) throw new Error("MCP OAuth storage unavailable")
  const decoded = Schema.decodeUnknownOption(schema)(
    await response.json().catch(() => undefined),
  )
  if (Option.isNone(decoded))
    throw new Error("Invalid MCP OAuth storage response")
  return decoded.value
}

export function bucket<T>(
  origin: string,
  kind: string,
  schema: Schema.Decoder<T>,
): Bucket<T> {
  const partition = `${origin}#${kind}`
  const decode = Schema.decodeUnknownOption(schema)
  const record = ({ value, revision }: typeof Stored.Type) => {
    const decoded = decode(value)
    if (Option.isNone(decoded)) throw new Error("Invalid MCP OAuth record")
    return { revision, value: decoded.value }
  }
  return {
    get: async (key) => {
      const row = await request(MaybeRecord, { op: "get", partition, key })
      return row === null ? undefined : record(row)
    },
    async *entries() {
      let after: string | undefined
      for (;;) {
        const rows = await request(RecordPage, { op: "list", partition, after })
        for (const row of rows) yield record(row)
        after = rows.at(-1)?.key
        if (rows.length < 100) return
      }
    },
    put: async (key, value, expires, previous) => {
      const row = await request(MaybeRecord, {
        op: "put",
        partition,
        key,
        value,
        expires,
        previous: previous?.revision,
      })
      return row === null ? undefined : record(row)
    },
    remove: (key, previous) =>
      request(Schema.Boolean, {
        op: "remove",
        partition,
        key,
        previous: previous.revision,
      }),
  }
}
