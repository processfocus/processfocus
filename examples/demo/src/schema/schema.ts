import { sql } from "drizzle-orm"
import {
  customType,
  integer,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core"
import { DateTime } from "effect"
import { ulid } from "ulidx"

/**
 * Custom type for Effect DateTime columns.
 * Stores as Julian day number (real) for SQLite compatibility.
 */
const effectDateTime = customType<{ data: DateTime.Utc; driverData: number }>({
  dataType() {
    return "real"
  },
  toDriver(value: DateTime.Utc): number {
    return DateTime.toEpochMillis(value) / 86400000 + 2440587.5
  },
  fromDriver(value: number): DateTime.Utc {
    return DateTime.unsafeMake((value - 2440587.5) * 86400000)
  },
})

/**
 * Purchase Order table for demo organization.
 *
 * Simple table for purchase orders with item name and price.
 */
export const purchaseOrder = sqliteTable("purchase_order", {
  id: text("id", { length: 41 })
    .primaryKey()
    .$defaultFn(() => `po-${ulid()}`),
  /** The purchase order item name */
  item: text("item", { length: 200 }).notNull(),
  /** The price as a number */
  price: real("price").notNull(),
  // Standard audit fields
  createdAt: effectDateTime("created_at")
    .notNull()
    .default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at")
    .notNull()
    .default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
})

export type PurchaseOrder = typeof purchaseOrder.$inferSelect
export type NewPurchaseOrder = typeof purchaseOrder.$inferInsert
