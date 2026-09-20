import { strict as assert } from "node:assert"
import type { SqlError } from "@effect/sql/SqlError"
import { asc, count, eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import * as systemSchema from "@pf/drizzle-sqlite"
import { type UserDetails, getUserDetails } from "@pf/graphql-db-operations"
import type { ListQueryContext, ListQueryResult } from "@pf/process"
import {
  type ListQuerySortExpression,
  listQueryOrderBy,
  listQuerySelectedSortFields,
} from "@pf/process/list-query-order-by"
import { type RequestTime, getRequestTime } from "@pf/request-time"
import * as schema from "./schema"
import { TypedDemoDrizzle } from "./typed-drizzle"

/**
 * Output type for a Purchase Order in list queries.
 */
interface PurchaseOrderListItem {
  readonly id: string
  readonly item: string
  readonly price: number
}

/**
 * Detail output type for a single Purchase Order.
 */
interface PurchaseOrderDetail {
  readonly id: string
  readonly item: string
  readonly price: number
}

/**
 * Input for creating a Purchase Order record.
 */
interface CreatePurchaseOrderInput {
  readonly item: string
  readonly price: number
}

interface ProcessCatalogListItem {
  readonly id: string
  readonly name: string
  readonly path: string
}

/**
 * Service providing demo-specific database operations.
 *
 * These operations work with the custom purchase_order table
 * and integrate with the standard audit fields (requestTime, userDetails).
 */
export class DemoOperations extends Context.Tag("@pf/demo/DemoOperations")<
  DemoOperations,
  {
    /**
     * Create a new Purchase Order record.
     *
     * @param input - Purchase order data including item and price
     * @returns The ID of the newly created purchase order
     */
    readonly createPurchaseOrder: (
      input: CreatePurchaseOrderInput,
    ) => Effect.Effect<string, SqlError, RequestTime | UserDetails>

    /**
     * Query Purchase Orders with pagination.
     *
     * @param ctx - Query context with pagination and optional filter text
     * @returns Paginated list of Purchase Orders
     */
    readonly queryPurchaseOrders: (
      ctx: ListQueryContext,
    ) => Effect.Effect<ListQueryResult<PurchaseOrderListItem>, SqlError, never>

    readonly queryProcessCatalog: (
      ctx: ListQueryContext,
    ) => Effect.Effect<ListQueryResult<ProcessCatalogListItem>, SqlError, never>

    /**
     * Query a single Purchase Order by ID.
     *
     * @param id - The purchase_order ID
     * @returns The purchase order detail or null if not found
     */
    readonly queryPurchaseOrderById: (
      id: string,
    ) => Effect.Effect<PurchaseOrderDetail | null, SqlError, never>

    /**
     * Update a Purchase Order record.
     *
     * @param id - The purchase_order ID
     * @param input - Fields to update
     * @returns The updated purchase order detail or null if not found
     */
    readonly updatePurchaseOrder: (
      id: string,
      input: {
        item?: string
        price?: number
      },
    ) => Effect.Effect<
      PurchaseOrderDetail | null,
      SqlError,
      RequestTime | UserDetails
    >
  }
>() {}

/**
 * Live implementation of DemoOperations using TypedDemoDrizzle.
 */
export const DemoOperationsLive = Layer.effect(
  DemoOperations,
  Effect.gen(function* () {
    const db = yield* TypedDemoDrizzle

    return {
      createPurchaseOrder: (input: CreatePurchaseOrderInput) =>
        Effect.gen(function* () {
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()

          const results = yield* db
            .insert(schema.purchaseOrder)
            .values({
              item: input.item,
              price: input.price,
              createdAt: requestTime,
              updatedAt: requestTime,
              createdBy: userDetails.by,
              updatedBy: userDetails.by,
            })
            .returning({ id: schema.purchaseOrder.id })

          assert(results[0], "Insert must return at least one row")
          return results[0].id
        }),

      queryPurchaseOrders: (ctx) =>
        Effect.gen(function* () {
          const offset = (ctx.page - 1) * ctx.limit

          const selectedFields = {
            id: schema.purchaseOrder.id,
            item: schema.purchaseOrder.item,
            price: schema.purchaseOrder.price,
          } satisfies Record<string, ListQuerySortExpression>

          // Query items with pagination
          const items = yield* db
            .select(selectedFields)
            .from(schema.purchaseOrder)
            .where(eq(schema.purchaseOrder._deleted, false))
            .orderBy(
              ...listQueryOrderBy({
                sort: ctx.sort,
                fields: {
                  ...listQuerySelectedSortFields(selectedFields, {
                    caseInsensitive: ["item"],
                  }),
                },
                defaultOrder: [
                  asc(schema.purchaseOrder.item),
                  asc(schema.purchaseOrder.id),
                ],
                tieBreaker: schema.purchaseOrder.id,
              }),
            )
            .limit(ctx.limit)
            .offset(offset)

          // Query total count
          const countResult = yield* db
            .select({ count: count() })
            .from(schema.purchaseOrder)
            .where(eq(schema.purchaseOrder._deleted, false))

          const totalCount = countResult[0]?.count ?? 0

          return {
            items,
            totalCount,
          }
        }),

      queryProcessCatalog: (ctx) =>
        Effect.gen(function* () {
          const offset = (ctx.page - 1) * ctx.limit
          const selectedFields = {
            id: systemSchema.process.id,
            name: systemSchema.process.name,
            path: systemSchema.process.path,
          } satisfies Record<string, ListQuerySortExpression>

          // Demo smoke list: expose every imported process for read-only browsing.
          const items = yield* db
            .select(selectedFields)
            .from(systemSchema.process)
            .where(eq(systemSchema.process._deleted, false))
            .orderBy(
              ...listQueryOrderBy({
                sort: ctx.sort,
                fields: {
                  ...listQuerySelectedSortFields(selectedFields, {
                    caseInsensitive: ["name", "path"],
                  }),
                },
                defaultOrder: [
                  asc(systemSchema.process.name),
                  asc(systemSchema.process.id),
                ],
                tieBreaker: systemSchema.process.id,
              }),
            )
            .limit(ctx.limit)
            .offset(offset)

          const countResult = yield* db
            .select({ count: count() })
            .from(systemSchema.process)
            .where(eq(systemSchema.process._deleted, false))

          return {
            items,
            totalCount: countResult[0]?.count ?? 0,
          }
        }),

      queryPurchaseOrderById: (id: string) =>
        Effect.gen(function* () {
          const results = yield* db
            .select({
              id: schema.purchaseOrder.id,
              item: schema.purchaseOrder.item,
              price: schema.purchaseOrder.price,
            })
            .from(schema.purchaseOrder)
            .where(eq(schema.purchaseOrder.id, id))
            .limit(1)

          return results[0] ?? null
        }),

      updatePurchaseOrder: (
        id: string,
        input: { item?: string; price?: number },
      ) =>
        Effect.gen(function* () {
          const requestTime = yield* getRequestTime()
          const userDetails = yield* getUserDetails()

          // Build update object with only defined fields
          const updateData: Record<string, unknown> = {
            updatedAt: requestTime,
            updatedBy: userDetails.by,
          }
          if (input.item !== undefined) {
            updateData["item"] = input.item
          }
          if (input.price !== undefined) {
            updateData["price"] = input.price
          }

          // Update the record
          yield* db
            .update(schema.purchaseOrder)
            .set(updateData)
            .where(eq(schema.purchaseOrder.id, id))

          // Fetch and return the updated record
          const results = yield* db
            .select({
              id: schema.purchaseOrder.id,
              item: schema.purchaseOrder.item,
              price: schema.purchaseOrder.price,
            })
            .from(schema.purchaseOrder)
            .where(eq(schema.purchaseOrder.id, id))
            .limit(1)

          return results[0] ?? null
        }),
    }
  }),
)
