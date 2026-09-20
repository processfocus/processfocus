import { AsyncLocalStorage } from "node:async_hooks"
import * as Client from "@effect/sql/SqlClient"
import { SqlError, SqlErrorTypeId } from "@effect/sql/SqlError"
import { defineRelations } from "drizzle-orm"
import { PgAsyncDeleteBase } from "drizzle-orm/pg-core/async/delete"
import { PgAsyncInsertBase } from "drizzle-orm/pg-core/async/insert"
import { PgAsyncRelationalQuery } from "drizzle-orm/pg-core/async/query"
import { PgAsyncSelectBase } from "drizzle-orm/pg-core/async/select"
import { PgAsyncUpdateBase } from "drizzle-orm/pg-core/async/update"
import type { DrizzlePgConfig } from "drizzle-orm/pg-core/utils"
import type { PgRemoteDatabase } from "drizzle-orm/pg-proxy"
import { drizzle } from "drizzle-orm/pg-proxy"
import type { AnyRelations } from "drizzle-orm/relations"
import {
  Context,
  Effect,
  Effectable,
  Either,
  Layer,
  Predicate,
  Runtime,
} from "effect"
import * as schema from "@pf/drizzle-postgres"

declare module "drizzle-orm" {
  interface QueryPromise<T> extends Effect.Effect<T, SqlError> {}
}

const relations = defineRelations(schema, (r) => ({
  process: {
    orgUnit: r.one.orgUnit({
      from: r.process.orgUnitId,
      to: r.orgUnit.id,
      optional: false,
    }),
  },
  providerUser: {
    user: r.one.user({
      from: r.providerUser.userId,
      to: r.user.id,
      optional: false,
    }),
    orgUnit: r.one.orgUnit({
      from: r.providerUser.orgUnitId,
      to: r.orgUnit.id,
      optional: false,
    }),
  },
  providerUserRole: {
    role: r.one.role({
      from: r.providerUserRole.roleId,
      to: r.role.id,
      optional: false,
    }),
  },
}))

type TypedPostgresDatabase = Effect.Effect.Success<
  ReturnType<typeof makePostgresDrizzle<typeof relations>>
>

const runtimeStorage = new AsyncLocalStorage<Runtime.Runtime<never>>()

const patchEffectCommit = (prototype: object) => {
  if (Object.hasOwn(prototype, Effect.EffectTypeId)) return

  // Drizzle async builders are Promise-like. This local adapter makes the
  // Postgres builders returned by this service yieldable as Effects without
  // patching QueryPromise.prototype globally, which previously leaked into
  // SQLite tests.
  Object.assign(prototype, {
    ...Effectable.CommitPrototype,
    commit(this: { execute: () => Promise<unknown> }) {
      return Effect.runtime<never>().pipe(
        Effect.flatMap((runtime) =>
          Effect.tryPromise({
            try: () => runtimeStorage.run(runtime, () => this.execute()),
            catch: (cause) =>
              // Preserve structured SqlError from the promise bridge; wrap only
              // unknown rejections (e.g. raw driver/Drizzle failures).
              Predicate.hasProperty(cause, SqlErrorTypeId)
                ? (cause as SqlError)
                : new SqlError({
                    cause,
                    message: "Failed to execute Drizzle query",
                  }),
          }),
        ),
      )
    },
  })
}

/**
 * Patch Drizzle Postgres async builder prototypes so they are yieldable as
 * Effects. Idempotent; called from TypedPostgresDrizzleLayer construction
 * rather than at module import time.
 */
const ensurePostgresEffectCommitPatches = Effect.sync(() => {
  patchEffectCommit(PgAsyncSelectBase.prototype)
  patchEffectCommit(PgAsyncInsertBase.prototype)
  patchEffectCommit(PgAsyncUpdateBase.prototype)
  patchEffectCommit(PgAsyncDeleteBase.prototype)
  patchEffectCommit(PgAsyncRelationalQuery.prototype)
})

const makeRemoteCallback = Effect.gen(function* () {
  const client = yield* Client.SqlClient
  const constructionRuntime = yield* Effect.runtime<never>()

  return (
    query: string,
    params: Array<unknown>,
    method: "all" | "execute" | "get" | "run" | "values",
  ) => {
    const runPromise = Runtime.runPromise(
      runtimeStorage.getStore() ?? constructionRuntime,
    )
    const statement = client.unsafe(query, params)
    const effect =
      method === "execute"
        ? Effect.map(statement.raw, (header) => ({ rows: [header] }))
        : Effect.map(
            method === "all" || method === "values"
              ? statement.values
              : statement.withoutTransform,
            (rows) => ({ rows: method === "get" ? (rows[0] ?? []) : rows }),
          )

    // Throw the full SqlError (not only .cause) so query context survives the
    // promise bridge. patchEffectCommit rethrows SqlError as-is and wraps only
    // non-SqlError rejections.
    return runPromise(Effect.either(effect)).then((result) =>
      Either.match(result, {
        onLeft: (error) => {
          throw error
        },
        onRight: (value) => value,
      }),
    )
  }
})

const makePostgresDrizzle = <TRelations extends AnyRelations>(
  config?: Omit<DrizzlePgConfig<TRelations>, "logger">,
): Effect.Effect<PgRemoteDatabase<TRelations>, never, Client.SqlClient> =>
  Effect.gen(function* () {
    const callback = yield* makeRemoteCallback
    return drizzle<TRelations>(
      callback as Parameters<typeof drizzle<TRelations>>[0],
      config as Parameters<typeof drizzle<TRelations>>[1],
    )
  })

/**
 * Tag for typed Drizzle ORM database service.
 *
 * This tag provides a fully typed PgRemoteDatabase with the monorepo's
 * Drizzle schema (@pf/drizzle-postgres). When you yield this tag,
 * you get typed query methods like `db.query.process.findMany()`.
 *
 * @example
 * ```typescript
 * import { TypedPostgresDrizzle, TypedPostgresDrizzleLayer } from "@pf/service-drizzle-postgres"
 * import { PgClient } from "@effect/sql-pg"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function* () {
 *   const db = yield* TypedPostgresDrizzle
 *   // Use typed query builder
 *   const results = yield* db.query.process.findMany()
 * }).pipe(
 *   Effect.provide(TypedPostgresDrizzleLayer),
 *   Effect.provide(PgLive)
 * )
 * ```
 */
export class TypedPostgresDrizzle extends Context.Tag(
  "@pf/service-drizzle-postgres/TypedPostgresDrizzle",
)<TypedPostgresDrizzle, TypedPostgresDatabase>() {}

/**
 * Layer that provides the TypedPostgresDrizzle service.
 *
 * This layer creates a typed Drizzle database instance with the monorepo's
 * schema and provides it through the TypedPostgresDrizzle tag. DatabaseConnectionInfo
 * from the driver layer is automatically available to consumers since it's provided
 * by the same driver layer (DatabaseLive).
 *
 * Requires a SQL client (PgClient) to be provided externally. Use this layer
 * in combination with a PgClient layer configuration like DatabaseLive.
 *
 * Prototype patches for yieldable Drizzle builders run once during layer
 * construction (idempotent), not at module import time.
 */
export const TypedPostgresDrizzleLayer = Layer.effect(
  TypedPostgresDrizzle,
  Effect.gen(function* () {
    yield* ensurePostgresEffectCommitPatches
    return yield* makePostgresDrizzle<typeof relations>({ relations })
  }),
)
