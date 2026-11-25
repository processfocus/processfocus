import "./make-sqlite-drizzle"
import { defineRelations } from "drizzle-orm"
import type { SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy"
import { Context, Layer } from "effect"
import * as schema from "@pf/drizzle-sqlite"
import { makeSqliteDrizzle } from "./make-sqlite-drizzle"

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

type TypedSqliteDatabase = SqliteRemoteDatabase<typeof schema, typeof relations>
/**
 * Tag for typed Drizzle ORM database service.
 *
 * This tag provides a fully typed SqliteRemoteDatabase with the monorepo's
 * Drizzle schema (@pf/drizzle-sqlite). When you yield this tag,
 * you get typed query methods like `db.query.process.findMany()`.
 *
 * @example
 * ```typescript
 * import { TypedSqliteDrizzle, TypedSqliteDrizzleLayer } from "@pf/service-drizzle-sqlite"
 * import { TursoLive } from "@pf/layer-turso-local"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function* () {
 *   const db = yield* TypedSqliteDrizzle
 *   // Use typed query builder
 *   const results = yield* db.query.process.findMany()
 * }).pipe(
 *   Effect.provide(TypedSqliteDrizzleLayer),
 *   Effect.provide(TursoLive)
 * )
 * ```
 */
export class TypedSqliteDrizzle extends Context.Service<
  TypedSqliteDrizzle,
  TypedSqliteDatabase
>()("@pf/service-drizzle-sqlite/TypedSqliteDrizzle") {}

/**
 * Layer that provides the TypedSqliteDrizzle service.
 *
 * This layer creates a typed Drizzle database instance with the monorepo's
 * schema and provides it through the TypedSqliteDrizzle tag.
 *
 * SQLite pragmas (foreign_keys, journal_mode, busy_timeout) are handled by
 * the underlying SQL client layer (TursoLive, SqliteLive, etc.) and executed
 * lazily on first database query.
 *
 * Requires a SQL client to be provided externally. Use this with
 * @pf/layer-sqlite-bun, @pf/layer-turso-local, or @pf/layer-turso-cloud.
 */
export const TypedSqliteDrizzleLayer = Layer.effect(
  TypedSqliteDrizzle,
  makeSqliteDrizzle({ schema, relations }),
)
