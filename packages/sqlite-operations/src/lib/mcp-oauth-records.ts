import { randomUUID } from "node:crypto"
import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm"
import { DateTime, Effect, Layer } from "effect"
import { mcpOauthRecord as records } from "@pf/drizzle-sqlite"
import { McpOAuthRecords } from "@pf/graphql-db-operations"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"
import { retryTransientSqliteError } from "./transient-sqlite-error"

const active = eq(records._deleted, sql`0`)
const projection = {
  key: records.mcpRecordKey,
  revision: records.mcpRevision,
  value: records.keyValue,
}

export const SqliteMcpOAuthRecordsLive = Layer.effect(
  McpOAuthRecords,
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle
    return McpOAuthRecords.of({
      operate: (operation, now) =>
        Effect.gen(function* () {
          const partition = and(
            active,
            eq(records.mcpPartition, operation.partition),
          )
          const alive = or(
            isNull(records.keyExpiry),
            gt(records.keyExpiry, now),
          )
          if (operation.op === "list") {
            return yield* db
              .select(projection)
              .from(records)
              .where(
                and(
                  partition,
                  alive,
                  operation.after === undefined
                    ? undefined
                    : gt(records.mcpRecordKey, operation.after),
                ),
              )
              .orderBy(records.mcpRecordKey)
              .limit(100)
          }

          const key = and(partition, eq(records.mcpRecordKey, operation.key))
          if (operation.op === "get") {
            const [row] = yield* db
              .select(projection)
              .from(records)
              .where(and(key, alive))
            return row ?? null
          }
          if (operation.op === "remove") {
            const rows = yield* retryTransientSqliteError(
              db
                .delete(records)
                .where(
                  and(key, alive, eq(records.mcpRevision, operation.previous)),
                )
                .returning({ key: records.mcpRecordKey }),
            )
            return rows.length > 0
          }

          const next = {
            mcpRevision: randomUUID(),
            keyValue: operation.value,
            keyExpiry:
              operation.expires === undefined
                ? null
                : DateTime.makeUnsafe(operation.expires),
          }
          if (operation.previous !== undefined) {
            const [row] = yield* retryTransientSqliteError(
              db
                .update(records)
                .set(next)
                .where(
                  and(key, alive, eq(records.mcpRevision, operation.previous)),
                )
                .returning(projection),
            )
            return row ?? null
          }

          // Expired credentials are rejected even when no writes have run to
          // collect them. The expiry index keeps this cleanup off live rows.
          yield* retryTransientSqliteError(
            db.delete(records).where(and(active, lte(records.keyExpiry, now))),
          )
          const [row] = yield* retryTransientSqliteError(
            db
              .insert(records)
              .values({
                ...next,
                mcpPartition: operation.partition,
                mcpRecordKey: operation.key,
              })
              .onConflictDoNothing()
              .returning(projection),
          )
          return row ?? null
        }),
    })
  }),
)
