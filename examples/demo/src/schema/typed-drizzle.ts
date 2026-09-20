import * as SqliteDrizzle from "@effect/sql-drizzle/Sqlite"
import type { SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy"
import { Context, Layer } from "effect"
import * as systemSchema from "@pf/drizzle-sqlite"
import * as customSchema from "./schema"

/**
 * Combined schema merging system tables with demo-specific custom tables.
 */
const combinedSchema = { ...systemSchema, ...customSchema }
type CombinedSchema = typeof combinedSchema

/**
 * Tag for typed Drizzle ORM database service with combined schema.
 *
 * This service provides access to both system tables (from @pf/drizzle-sqlite)
 * and demo-specific custom tables (purchase_order, etc.).
 *
 * @example
 * ```typescript
 * const db = yield* TypedDemoDrizzle
 * // Access system tables
 * const employees = yield* db.query.employee.findMany()
 * // Access custom tables
 * const purchaseOrders = yield* db.query.purchaseOrder.findMany()
 * ```
 */
export class TypedDemoDrizzle extends Context.Tag("@pf/demo/TypedDemoDrizzle")<
  TypedDemoDrizzle,
  SqliteRemoteDatabase<CombinedSchema>
>() {}

/**
 * Layer that provides the TypedDemoDrizzle service.
 *
 * Creates a Drizzle instance with combined system + custom schema.
 * Requires a SQL client layer to be provided.
 */
export const TypedDemoDrizzleLayer = Layer.effect(
  TypedDemoDrizzle,
  SqliteDrizzle.make<CombinedSchema>({ schema: combinedSchema }),
)
