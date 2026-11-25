import { AsyncLocalStorage } from "node:async_hooks"
import type { DrizzleConfig } from "drizzle-orm"
import type { BatchResponse } from "drizzle-orm/batch"
import type { AnyRelations, EmptyRelations } from "drizzle-orm/relations"
import {
  SQLiteDeleteBase,
  SQLiteInsertBase,
  type SQLiteSelect,
  SQLiteSelectBase,
  SQLiteUpdateBase,
} from "drizzle-orm/sqlite-core"
import { SQLiteRelationalQuery as LegacySQLiteRelationalQuery } from "drizzle-orm/sqlite-core/query-builders/_query"
import { SQLiteRelationalQuery } from "drizzle-orm/sqlite-core/query-builders/query"
import { SQLiteRaw } from "drizzle-orm/sqlite-core/query-builders/raw"
import { type SqliteRemoteDatabase, drizzle } from "drizzle-orm/sqlite-proxy"
import { type Context, Effect, Effectable, Option } from "effect"
import { SqlClient } from "effect/sql"
import { SqlError, UnknownError, isSqlError } from "effect/sql/SqlError"
import { SqlReadBatch } from "@pf/db-info"

declare module "drizzle-orm" {
  interface QueryPromise<T> extends Effect.Effect<T, SqlError> {}
}

type Query = Effect.Effect<unknown, SqlError> & {
  execute(): Promise<unknown>
}

const execution = new AsyncLocalStorage<{
  readonly context: Context.Context<never>
  readonly signal: AbortSignal
}>()

const queryPrototype = Effectable.Prototype<Query>({
  label: "ProcessFocusSqliteQuery",
  evaluate() {
    return Effect.context<never>().pipe(
      Effect.flatMap((context) =>
        Effect.tryPromise({
          try: (signal) =>
            execution.run({ context, signal }, () => this.execute()),
          catch: (cause) =>
            isSqlError(cause)
              ? cause
              : new SqlError({
                  reason: new UnknownError({
                    cause,
                    message: "Failed to execute Drizzle query",
                  }),
                }),
        }),
      ),
    )
  },
})

// Pick public members so Drizzle's Omit-based .where/.limit builders fit too.
type SqliteReadQuery = Pick<SQLiteSelect, "getSQL" | "toSQL"> & {
  readonly _: Pick<SQLiteSelect["_"], "dialect" | "selection"> & {
    readonly result: unknown
  }
  execute(): Promise<unknown>
}

/** Explicit independent SELECT group; Drizzle retains its typed row decoding. */
export const batchSqliteReads = <
  TSchema extends Record<string, unknown>,
  TRelations extends AnyRelations,
  T extends readonly [SqliteReadQuery, ...SqliteReadQuery[]],
>(
  db: SqliteRemoteDatabase<TSchema, TRelations>,
  queries: T,
): Effect.Effect<BatchResponse<T>, SqlError> =>
  Effect.context<never>().pipe(
    Effect.flatMap((context) =>
      Effect.tryPromise({
        try: (signal) =>
          execution.run({ context, signal }, () => db.batch(queries)),
        catch: (cause) =>
          isSqlError(cause)
            ? cause
            : new SqlError({
                reason: new UnknownError({
                  cause,
                  message: "Failed to execute Drizzle read batch",
                }),
              }),
      }),
    ),
  )

/** Retain the caller's transaction and cancellation across Drizzle's Promise boundary. */
export const makeSqliteDrizzle = <
  TSchema extends Record<string, unknown> = Record<string, never>,
  TRelations extends AnyRelations = EmptyRelations,
>(
  config?: Omit<DrizzleConfig<TSchema, TRelations>, "logger">,
): Effect.Effect<
  SqliteRemoteDatabase<TSchema, TRelations>,
  never,
  SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    const client = yield* SqlClient.SqlClient
    const readBatch = yield* Effect.serviceOption(SqlReadBatch)
    const constructionContext = yield* Effect.context<never>()
    for (const prototype of [
      SQLiteSelectBase.prototype,
      SQLiteInsertBase.prototype,
      SQLiteUpdateBase.prototype,
      SQLiteDeleteBase.prototype,
      SQLiteRelationalQuery.prototype,
      LegacySQLiteRelationalQuery.prototype,
      SQLiteRaw.prototype,
    ]) {
      if (!Object.hasOwn(prototype, Effect.TypeId)) {
        Object.defineProperties(
          prototype,
          Object.getOwnPropertyDescriptors(queryPrototype),
        )
      }
    }
    return drizzle<TSchema, TRelations>(
      (query, params, method) => {
        // Yield query builders inside SqlClient.withTransaction: evaluation installs
        // the caller context here. Plain Promise callers use the construction
        // context and cannot inherit a surrounding Effect transaction.
        const active = execution.getStore()
        const statement = client.unsafe(query, params)
        const run = Effect.runPromiseWith(
          active?.context ?? constructionContext,
        )
        const options = active ? { signal: active.signal } : undefined
        if (method === "get") {
          return run(
            Effect.map(statement.values, (rows) => ({
              rows: Array.from(rows[0] ?? []),
            })),
            options,
          )
        }
        const result =
          method === "run" ? statement.withoutTransform : statement.values
        return run(
          Effect.map(result, (rows) => ({ rows: Array.from(rows) })),
          options,
        )
      },
      (batch) => {
        const active = execution.getStore()
        const run = Effect.runPromiseWith(
          active?.context ?? constructionContext,
        )
        const options = active ? { signal: active.signal } : undefined
        // Enabling the native batch callback must not introduce a write path.
        if (batch.some((query) => query.method !== "all")) {
          return run(
            Effect.fail(
              new SqlError({
                reason: new UnknownError({
                  cause: undefined,
                  message: "Only SELECT queries are supported in read batches",
                }),
              }),
            ),
            options,
          )
        }
        const statements = batch.map(({ sql, params }) => ({ sql, params }))
        const effect = Option.isSome(readBatch)
          ? readBatch.value.execute(statements)
          : Effect.forEach(
              statements,
              ({ sql, params }) => client.unsafe(sql, params).values,
              { concurrency: 1 },
            )
        return run(
          Effect.map(effect, (results) =>
            results.map((rows) => ({
              rows: rows.map((row) => Array.from(row)),
            })),
          ),
          options,
        )
      },
      config,
    )
  })
