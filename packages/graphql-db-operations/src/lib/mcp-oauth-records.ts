import { Context, type DateTime, type Effect, Schema } from "effect"
import type { SqlError } from "effect/sql/SqlError"

const partition = Schema.String.check(Schema.isMaxLength(2048))
const key = Schema.String.check(Schema.isMaxLength(64))
const revision = Schema.String.check(Schema.isMaxLength(36))

export const McpOAuthOperation = Schema.Union([
  Schema.Struct({ op: Schema.Literal("get"), partition, key }),
  Schema.Struct({
    op: Schema.Literal("list"),
    partition,
    after: Schema.optional(key),
  }),
  Schema.Struct({
    op: Schema.Literal("put"),
    partition,
    key,
    value: Schema.Record(Schema.String, Schema.Json),
    expires: Schema.optional(Schema.Int),
    previous: Schema.optional(revision),
  }),
  Schema.Struct({
    op: Schema.Literal("remove"),
    partition,
    key,
    previous: revision,
  }),
])

type McpOAuthRecord = { key: string; value: unknown; revision: string }

export class McpOAuthRecords extends Context.Service<
  McpOAuthRecords,
  {
    readonly operate: (
      operation: typeof McpOAuthOperation.Type,
      now: DateTime.Utc,
    ) => Effect.Effect<
      McpOAuthRecord | McpOAuthRecord[] | boolean | null,
      SqlError
    >
  }
>()("@pf/graphql-db-operations/McpOAuthRecords") {}
