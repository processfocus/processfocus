import { Effect } from "effect"
import { parse } from "@pf/xplain-ddl"
import {
  generateDrizzleSchema,
  generateTriggerSQL,
} from "./generator.sqlite.js"
import { validateTypeScriptSyntax } from "./test-utils.js"
import { describe, expect, it } from "bun:test"

const parseAndGenerate = async (
  source: string,
  prefix = "",
): Promise<string> => {
  const program = Effect.gen(function* () {
    const ast = yield* parse(source)
    return yield* generateDrizzleSchema(ast, "test.ddl", prefix)
  }).pipe(Effect.tap(validateTypeScriptSyntax))

  return Effect.runPromise(program)
}

describe("generateDrizzleSchema (SQLite)", () => {
  it("names duplicate edges and matches the existing history inverse", async () => {
    const schema = await parseAndGenerate(`
      base name (A64).
      type delegation = name.
      type secret generation = delegation.
      type delegation history = delegation, secret generation,
        optional actor_delegation, optional actor_secret generation.
    `)

    for (const target of ["delegation", "secretGeneration"]) {
      const actor = `actor${target[0]!.toUpperCase()}${target.slice(1)}`
      expect(schema).toContain(
        `${target}: one(${target}, {\n    relationName: "delegationHistory_${target}",`,
      )
      expect(schema).toContain(
        `${actor}: one(${target}, {\n    relationName: "delegationHistory_${actor}",`,
      )
      expect(schema).toContain(
        `delegationHistories: many(delegationHistory, { relationName: "delegationHistory_${target}" }),`,
      )
    }
    expect(schema).toContain("secretGenerations: many(secretGeneration),")
  })

  it("should generate schema with basic types", async () => {
    const source = `
      base name (A64).
      base active (B).
      type customer = name, active.
    `

    const schema = await parseAndGenerate(source)

    expect(schema).toContain('from "drizzle-orm/sqlite-core"')
    expect(schema).toContain('import { sql } from "drizzle-orm"')
    expect(schema).toContain('import { DateTime } from "effect"')
    expect(schema).toContain("export const customer = sqliteTable")
    expect(schema).toContain(
      'id: text("id", { length: 41 }).primaryKey().$defaultFn(() => ulid())',
    )
    expect(schema).toContain('name: text("name", { length: 64 }).notNull()')
    expect(schema).toContain(
      'active: integer("active", { mode: "boolean" }).notNull()',
    )
    expect(schema).toContain(
      "createdAt: effectDateTime(\"created_at\").notNull().default(sql`(julianday('now'))`)",
    )
    expect(schema).toContain(
      "updatedAt: effectDateTime(\"updated_at\").notNull().default(sql`(julianday('now'))`)",
    )
    expect(schema).toContain(
      'createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM")',
    )
    expect(schema).toContain(
      'updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM")',
    )
    expect(schema).toContain(
      '_deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false)',
    )
  })

  it("should handle optional attributes", async () => {
    const source = `
      base description (T).
      type product = optional description.
    `

    const schema = await parseAndGenerate(source)

    expect(schema).toContain('description: citextColumn("description"),')
    expect(schema).not.toContain(
      'description: citextColumn("description").notNull()',
    )
  })

  it("should handle all data types", async () => {
    const source = `
      base field (A100).
      base flag (B).
      base timestamp (D).
      base number (I10).
      base decimal (R10,2).
      base longtext (T).
      base identifier (U).

      type test = text_field, bool_flag, datetime_timestamp, int_number, real_decimal, long_longtext, urn_identifier.
    `

    const schema = await parseAndGenerate(source)

    expect(schema).toContain(
      'textField: text("text_field", { length: 100 }).notNull()',
    )
    expect(schema).toContain(
      'boolFlag: integer("bool_flag", { mode: "boolean" }).notNull()',
    )
    expect(schema).toContain(
      'datetimeTimestamp: effectDateTime("datetime_timestamp").notNull()',
    )
    expect(schema).toContain('intNumber: integer("int_number").notNull()')
    expect(schema).toContain('realDecimal: real("real_decimal").notNull()')
    expect(schema).toContain(
      'longLongtext: citextColumn("long_longtext").notNull()',
    )
    expect(schema).toContain(
      'urnIdentifier: text("urn_identifier", { length: 255 }).notNull()',
    )
  })

  it("should handle case-insensitive text type (C)", async () => {
    const source = `
      base name (C256).

      type person = name.
    `

    const schema = await parseAndGenerate(source)

    // Should use citextColumn custom type
    expect(schema).toContain('name: citextColumn("name").notNull()')

    // Should include custom type definition
    expect(schema).toContain("const citextColumn = customType")
    expect(schema).toContain('return "text collate nocase"')

    // Should include CHECK constraint for length
    expect(schema).toContain(
      'nameLengthCheck: check("name_length_check", sql.raw(`length("person"."name") <= 256`))',
    )
  })

  it("should generate indexes", async () => {
    const source = `
      base name (A64).
      base email (A255).
      type customer = name, email.
      index customer its name_idx = name.
      unique index customer its email_idx = email.
    `

    const schema = await parseAndGenerate(source)

    expect(schema).toContain(
      'nameIdxIdx: index("customer_name_idx_idx").on(table.name)',
    )
    expect(schema).toContain(
      'emailIdxIdx: uniqueIndex("customer_email_idx_idx").on(table.email)',
    )
  })

  it("should generate check constraints from static assert declarations", async () => {
    const source = `
      base name (A64).
      type user = name.
      type external participant = name.
      type process state = optional started by_user, optional started by_external participant.
      assert process state its single starter (true) = started by_user == nil or started by_external participant == nil.
    `

    const schema = await parseAndGenerate(source)

    expect(schema).toContain("check")
    expect(schema).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing generated template string
      'singleStarterCheck: check("single_starter_check", sql`${table.startedByUserId} is null or ${table.startedByExternalParticipantId} is null`)',
    )
  })

  it("should generate mixed and chained OR check constraints", async () => {
    const source = `
      base value (I5).
      type item = optional first_value, second_value, optional third_value.
      assert item its valid values (true) = first_value == nil or second_value > 0 or third_value == nil.
    `

    const schema = await parseAndGenerate(source)

    expect(schema).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing generated template string
      'validValuesCheck: check("valid_values_check", sql`${table.firstValue} is null or ${table.secondValue} > 0 or ${table.thirdValue} is null`)',
    )
  })

  it("should fail clearly when static assert AST references unknown attributes", async () => {
    const invalidProgram = {
      bases: [
        {
          kind: "base" as const,
          name: "value",
          dataType: { type: "integer" as const, maxDigits: 5 },
        },
      ],
      types: [
        {
          kind: "type" as const,
          name: "item",
          attributes: [],
          indexes: [],
          uniqueIndexes: [],
          extends: [],
          asserts: [
            {
              name: "valid values",
              expression: {
                kind: "binary_op" as const,
                operator: "==" as const,
                left: { kind: "identifier" as const, name: "missing" },
                right: {
                  kind: "literal" as const,
                  valueType: "nil" as const,
                  value: null,
                },
              },
            },
          ],
        },
      ],
      asserts: [],
    }

    let rejected: unknown
    try {
      await Effect.runPromise(generateDrizzleSchema(invalidProgram, "test.ddl"))
    } catch (error) {
      rejected = error
    }

    expect(String(rejected)).toContain(
      "Unknown CHECK constraint attribute 'missing' on type 'item'",
    )
  })

  it("should handle multi-word identifiers", async () => {
    const source = `
      base name (A64).
      type invoice line = name.
    `

    const schema = await parseAndGenerate(source)

    expect(schema).toContain(
      'export const invoiceLine = sqliteTable("invoice_line"',
    )
  })

  it("should handle type references (foreign keys)", async () => {
    const source = `
      base name (A64).
      type customer = name.
      type invoice = customer.
    `

    const schema = await parseAndGenerate(source)

    expect(schema).toContain(
      'customerId: text("customer_id", { length: 41 }).notNull().references(() => customer.id)',
    )
  })

  it("should handle multiple foreign keys to the same type with descriptive names", async () => {
    const source = `
      base name (A64).
      type step = name.
      type flow = source_step, target_step.
    `

    const schema = await parseAndGenerate(source)

    expect(schema).toContain(
      'sourceStepId: text("source_step", { length: 41 }).notNull().references(() => step.id)',
    )
    expect(schema).toContain(
      'targetStepId: text("target_step", { length: 41 }).notNull().references(() => step.id)',
    )
  })

  it("should handle defaults with literals", async () => {
    const source = `
      base name (A64).
      base quantity (I5).
      type test = name, quantity.
      default test its name = "default".
      default test its quantity = 0.
    `

    const schema = await parseAndGenerate(source)

    // String and number defaults don't need sql template
    expect(schema).toContain('.default("default")')
    expect(schema).toContain(".default(0)")
  })

  it("should add file header comments", async () => {
    const source = `
      base name (A64).
      type customer = name.
    `

    const schema = await parseAndGenerate(source)

    expect(schema).toContain("// Generated from Xplain DDL: test.ddl")
    expect(schema).toContain("// Auto-generated - DO NOT EDIT")
  })

  it("should generate ID with prefix when type has idPrefix", async () => {
    const source = `
      base name (A64).
      type customer "cust" = name.
    `

    const schema = await parseAndGenerate(source)

    expect(schema).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing generated template string
      'id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `cust-${ulid()}`)',
    )
  })

  it("should generate ID without prefix when type has no idPrefix", async () => {
    const source = `
      base name (A64).
      type customer = name.
    `

    const schema = await parseAndGenerate(source)

    expect(schema).toContain(
      'id: text("id", { length: 41 }).primaryKey().$defaultFn(() => ulid())',
    )
  })

  it("should fail with unknown base type error when AST has invalid base reference", async () => {
    // Create an AST with an invalid base reference directly
    // (bypassing validation that would normally catch this)
    const invalidProgram = {
      bases: [
        {
          kind: "base" as const,
          name: "name",
          dataType: { type: "text" as const, maxLength: 64 },
        },
      ],
      types: [
        {
          kind: "type" as const,
          name: "customer",
          attributes: [
            {
              name: "name",
              baseName: "name",
              optional: false,
              isSpecialization: false,
            },
            {
              name: "invalid",
              baseName: "nonexistent",
              optional: false,
              isSpecialization: false,
            }, // Invalid base reference
          ],
          indexes: [],
          uniqueIndexes: [],
          extends: [],
          asserts: [],
        },
      ],
      asserts: [],
    }

    // Use Effect.flip to move error to success channel for testing
    const error = await Effect.runPromise(
      generateDrizzleSchema(invalidProgram, "test.ddl").pipe(Effect.flip),
    )

    expect(error._tag).toBe("UnknownBaseType")
    if (error._tag !== "UnknownBaseType") {
      throw new Error("Expected UnknownBaseType error")
    }
    // TypeScript now knows error is UnknownBaseType
    expect(error.attribute).toBe("invalid")
    expect(error.baseName).toBe("nonexistent")
  })

  it("should generate type exports for each table", async () => {
    const source = `
      base name (A64).
      type customer = name.
      type product = name.
    `

    const schema = await parseAndGenerate(source)

    expect(schema).toContain(
      "export type Customer = typeof customer.$inferSelect",
    )
    expect(schema).toContain(
      "export type NewCustomer = typeof customer.$inferInsert",
    )
    expect(schema).toContain(
      "export type Product = typeof product.$inferSelect",
    )
    expect(schema).toContain(
      "export type NewProduct = typeof product.$inferInsert",
    )
  })

  it("should generate relations for tables with foreign keys", async () => {
    const source = `
      base name (A64).
      type customer = name.
      type invoice = customer.
    `

    const schema = await parseAndGenerate(source)

    // Should import relations
    expect(schema).toContain(
      'import { relations } from "drizzle-orm/_relations"',
    )

    // Customer should have "many" relation to invoice
    expect(schema).toContain(
      "export const customerRelations = relations(customer, ({ many }) => ({",
    )
    expect(schema).toContain("invoices: many(invoice),")

    // Invoice should have "one" relation to customer
    expect(schema).toContain(
      "export const invoiceRelations = relations(invoice, ({ one }) => ({",
    )
    expect(schema).toContain("customer: one(customer, {")
    expect(schema).toContain("fields: [invoice.customerId],")
    expect(schema).toContain("references: [customer.id],")
  })

  it("should generate relations for complex relationships", async () => {
    const source = `
      base name (A64).
      type customer = name.
      type product = name.
      type invoice = customer.
      type invoice line = invoice, product.
    `

    const schema = await parseAndGenerate(source)

    // Customer should have many invoices
    expect(schema).toContain(
      "export const customerRelations = relations(customer, ({ many }) => ({",
    )
    expect(schema).toContain("invoices: many(invoice),")

    // Product should have many invoice lines
    expect(schema).toContain(
      "export const productRelations = relations(product, ({ many }) => ({",
    )
    expect(schema).toContain("invoiceLines: many(invoiceLine),")

    // Invoice should have one customer and many invoice lines
    expect(schema).toContain(
      "export const invoiceRelations = relations(invoice, ({ one, many }) => ({",
    )
    expect(schema).toContain("customer: one(customer, {")
    expect(schema).toContain("invoiceLines: many(invoiceLine),")

    // Invoice line should have one invoice and one product
    expect(schema).toContain(
      "export const invoiceLineRelations = relations(invoiceLine, ({ one }) => ({",
    )
    expect(schema).toContain("invoice: one(invoice, {")
    expect(schema).toContain("product: one(product, {")
  })

  it("should not generate relations for tables without foreign keys", async () => {
    const source = `
      base name (A64).
      type standalone = name.
    `

    const schema = await parseAndGenerate(source)

    // Should not have relations for standalone table
    expect(schema).not.toContain("standaloneRelations")
    // Should not import relations when there are no relations to generate
    expect(schema).not.toContain("import { relations }")
  })

  it("should handle self-references correctly", async () => {
    const source = `
      base name (A64).
      type org unit "ou" = name, parent_org unit.
    `

    const schema = await parseAndGenerate(source)

    // Should import AnySQLiteColumn as type-only import for self-references
    expect(schema).toContain("import type { AnySQLiteColumn }")

    // Column should be nullable (no .notNull()) and have explicit return type
    expect(schema).toContain(
      'parentOrgUnitId: text("parent_org_unit", { length: 41 }).references((): AnySQLiteColumn => orgUnit.id)',
    )
    expect(schema).not.toContain(
      'parentOrgUnitId: text("parent_org_unit", { length: 41 }).notNull()',
    )

    // Should have "one" relation for parent
    expect(schema).toContain(
      "export const orgUnitRelations = relations(orgUnit, ({ one, many }) => ({",
    )
    expect(schema).toContain("parentOrgUnit: one(orgUnit, {")
    expect(schema).toContain("fields: [orgUnit.parentOrgUnitId],")
    expect(schema).toContain("references: [orgUnit.id],")

    // Should have "many" relation for children
    expect(schema).toContain("children: many(orgUnit),")
  })

  it("should generate views for nil function extends", async () => {
    const source = `
      base name (A1024).
      type parent = name.
      type child = parent.
      extend parent with has no children = nil child per parent.
    `

    const schema = await parseAndGenerate(source)

    // Should import sqliteView and sql
    expect(schema).toContain('import { sql } from "drizzle-orm"')
    expect(schema).toContain("sqliteView")

    // Should have comment for views
    expect(schema).toContain("// Views for virtual attributes")

    // Should generate the view
    expect(schema).toContain(
      'export const parentItsHasNoChildren = sqliteView("parent_its_has_no_children", {',
    )
    expect(schema).toContain('id: text("id", { length: 41 }).notNull(),')
    expect(schema).toContain(
      'hasNoChildren: integer("has_no_children", { mode: "boolean" }).notNull(),',
    )
    expect(schema).toContain("}).as(sql`")

    // Should have the NOT EXISTS SQL with soft delete filter
    expect(schema).toContain(
      "not exists (select 1 from child where child.parent_id = parent.id and child._deleted = false)",
    )
    expect(schema).toContain("from parent")
  })

  it("should generate views for any function extends", async () => {
    const source = `
      base name (A1024).
      type parent = name.
      type child = parent.
      extend parent with has children = any child per parent.
    `

    const schema = await parseAndGenerate(source)

    // Should import sqliteView and sql
    expect(schema).toContain('import { sql } from "drizzle-orm"')
    expect(schema).toContain("sqliteView")

    // Should have comment for views
    expect(schema).toContain("// Views for virtual attributes")

    // Should generate the view
    expect(schema).toContain(
      'export const parentItsHasChildren = sqliteView("parent_its_has_children", {',
    )
    expect(schema).toContain('id: text("id", { length: 41 }).notNull(),')
    expect(schema).toContain(
      'hasChildren: integer("has_children", { mode: "boolean" }).notNull(),',
    )
    expect(schema).toContain("}).as(sql`")

    // Should have the EXISTS SQL with soft delete filter (not "not exists")
    expect(schema).toContain(
      "exists (select 1 from child where child.parent_id = parent.id and child._deleted = false)",
    )
    expect(schema).toContain("from parent")
  })

  it("should generate views for some function with base attribute", async () => {
    const source = `
      base name (A1024).
      base score (I10).
      type parent = name.
      type child = parent, score.
      extend parent with somescore = some child its score per parent.
    `

    const schema = await parseAndGenerate(source)

    // Should import sqliteView and sql
    expect(schema).toContain('import { sql } from "drizzle-orm"')
    expect(schema).toContain("sqliteView")

    // Should have comment for views
    expect(schema).toContain("// Views for virtual attributes")

    // Should generate the view
    expect(schema).toContain(
      'export const parentItsSomescore = sqliteView("parent_its_somescore", {',
    )
    expect(schema).toContain('id: text("id", { length: 41 }).notNull(),')
    expect(schema).toContain('somescore: integer("somescore"),')
    expect(schema).toContain("}).as(sql`")

    // Should have scalar subquery with LIMIT 1 and soft delete filter
    expect(schema).toContain(
      "(select child.score from child where child.parent_id = parent.id and child._deleted = false limit 1)",
    )
    expect(schema).toContain("from parent")
  })

  it("should generate views for some function with type reference", async () => {
    const source = `
      base name (A1024).
      type parent = name.
      type friend = name.
      type child = parent, best_friend.
      extend parent with somefriend = some child its best_friend per parent.
    `

    const schema = await parseAndGenerate(source)

    // Should import sqliteView and sql
    expect(schema).toContain('import { sql } from "drizzle-orm"')
    expect(schema).toContain("sqliteView")

    // Should generate the view with text type for foreign key
    expect(schema).toContain(
      'export const parentItsSomefriend = sqliteView("parent_its_somefriend", {',
    )
    expect(schema).toContain('id: text("id", { length: 41 }).notNull(),')
    expect(schema).toContain('somefriend: text("somefriend", { length: 41 }),')

    // Should select the foreign key column with soft delete filter
    expect(schema).toContain(
      "(select child.best_friend from child where child.parent_id = parent.id and child._deleted = false limit 1)",
    )
  })

  it("should generate views for some function with complex perPath", async () => {
    const source = `
      base name (A1024).
      base value (I10).
      type grandparent = name.
      type parent = grandparent, name.
      type child = parent, value.
      extend grandparent with somevalue = some child its value per parent its grandparent.
    `

    const schema = await parseAndGenerate(source)

    // Should generate the view
    expect(schema).toContain(
      'export const grandparentItsSomevalue = sqliteView("grandparent_its_somevalue", {',
    )

    // Should have JOIN in the subquery with soft delete filters
    expect(schema).toContain("select child.value from child")
    expect(schema).toContain(
      "join parent on child.parent_id = parent.id and parent._deleted = false",
    )
    expect(schema).toContain(
      "where parent.grandparent_id = grandparent.id and child._deleted = false limit 1",
    )
  })

  it("should generate views for assert declarations (treated as extends)", async () => {
    const source = `
      base name (A1024).
      type parent = name.
      type child = parent.
      assert parent its has children (1..*) = any child per parent.
    `

    const schema = await parseAndGenerate(source)

    // Should import sqliteView and sql
    expect(schema).toContain('import { sql } from "drizzle-orm"')
    expect(schema).toContain("sqliteView")

    // Should have comment for views
    expect(schema).toContain("// Views for virtual attributes")

    // Should generate the view (assert is treated like extend)
    expect(schema).toContain(
      'export const parentItsHasChildren = sqliteView("parent_its_has_children", {',
    )
    expect(schema).toContain('id: text("id", { length: 41 }).notNull(),')
    expect(schema).toContain(
      'hasChildren: integer("has_children", { mode: "boolean" }).notNull(),',
    )
    expect(schema).toContain("}).as(sql`")

    // Should have the EXISTS SQL with soft delete filter (any function)
    expect(schema).toContain(
      "exists (select 1 from child where child.parent_id = parent.id and child._deleted = false)",
    )
    expect(schema).toContain("from parent")
  })

  it("should generate one-to-one relations and unique indexes for specializations", async () => {
    const source = `
      base name (A64).
      base bedrooms (I2).
      type building = name.
      type house = bedrooms, [building].
    `
    const schema = await parseAndGenerate(source)

    // House table should have unique index on building_id
    expect(schema).toContain(
      'buildingUniqueIdx: uniqueIndex("house_building_unique_idx").on(table.buildingId)',
    )

    // Building should have "one" relation to house (not "many")
    expect(schema).toContain(
      "export const buildingRelations = relations(building, ({ one }) => ({",
    )
    expect(schema).toContain("house: one(house, {")
    expect(schema).toContain("fields: [building.id],")
    expect(schema).toContain("references: [house.buildingId],")

    // House should have "one" relation to building
    expect(schema).toContain(
      "export const houseRelations = relations(house, ({ one }) => ({",
    )
    expect(schema).toContain("building: one(building, {")
    expect(schema).toContain("fields: [house.buildingId],")
    expect(schema).toContain("references: [building.id],")
  })

  it("should handle multiple specializations of the same type", async () => {
    const source = `
      base name (A64).
      base bedrooms (I2).
      base desks (I3).
      type building = name.
      type house = bedrooms, [building].
      type office = desks, [building].
    `
    const schema = await parseAndGenerate(source)

    // Building should have two "one" relations (house and office)
    expect(schema).toContain(
      "export const buildingRelations = relations(building, ({ one }) => ({",
    )
    expect(schema).toContain("house: one(house, {")
    expect(schema).toContain("office: one(office, {")

    // Both should have unique indexes
    expect(schema).toContain(
      'buildingUniqueIdx: uniqueIndex("house_building_unique_idx").on(table.buildingId)',
    )
    expect(schema).toContain(
      'buildingUniqueIdx: uniqueIndex("office_building_unique_idx").on(table.buildingId)',
    )
  })

  it("should handle mixing regular attributes and specializations", async () => {
    const source = `
      base name (A64).
      base address (A128).
      type building = name.
      type tenant = name.
      type house = address, building, [tenant].
    `
    const schema = await parseAndGenerate(source)

    // House should have "one" relation to building (regular FK)
    expect(schema).toContain("building: one(building, {")
    expect(schema).toContain("fields: [house.buildingId],")

    // House should have "one" relation to tenant (specialization)
    expect(schema).toContain("tenant: one(tenant, {")
    expect(schema).toContain("fields: [house.tenantId],")

    // Building should have "many" relation to houses
    expect(schema).toContain(
      "export const buildingRelations = relations(building, ({ many }) => ({",
    )
    expect(schema).toContain("houses: many(house),")

    // Tenant should have "one" relation to house (specialization parent side)
    expect(schema).toContain(
      "export const tenantRelations = relations(tenant, ({ one }) => ({",
    )
    expect(schema).toContain("house: one(house, {")
    expect(schema).toContain("fields: [tenant.id],")
    expect(schema).toContain("references: [house.tenantId],")

    // Only tenant FK should have unique index (specialization)
    expect(schema).toContain(
      'tenantUniqueIdx: uniqueIndex("house_tenant_unique_idx").on(table.tenantId)',
    )
    expect(schema).not.toContain("buildingUniqueIdx")
  })

  it("should generate views for some function with where clause (no its)", async () => {
    const source = `
      base name (A1024).
      type process = name.
      type step = name, process.
      type flow = source_step, target_step.
      extend step with can start process = nil flow per target_step.
      extend process with start step = some step where can start process per process.
    `

    const schema = await parseAndGenerate(source)

    // Should import sqliteView and sql
    expect(schema).toContain('import { sql } from "drizzle-orm"')
    expect(schema).toContain("sqliteView")

    // Should generate view for the can start process extend
    expect(schema).toContain(
      'export const stepItsCanStartProcess = sqliteView("step_its_can_start_process"',
    )

    // Should generate view for the start step extend
    expect(schema).toContain(
      'export const processItsStartStep = sqliteView("process_its_start_step", {',
    )
    expect(schema).toContain('id: text("id", { length: 41 }).notNull(),')
    expect(schema).toContain('startStep: text("start_step", { length: 41 }),')
    expect(schema).toContain("}).as(sql`")

    // Should have scalar subquery selecting id with WHERE clause from joined view, including soft delete filter
    expect(schema).toContain("select step.id from step")
    expect(schema).toContain("join step_its_can_start_process")
    expect(schema).toContain("where step.process_id = process.id")
    expect(schema).toContain(
      "and step_its_can_start_process.can_start_process = 1",
    )
    expect(schema).toContain("and step._deleted = false")
    expect(schema).toContain("limit 1")
  })

  it("should generate views for some function with where clause and its clause", async () => {
    const source = `
      base name (A1024).
      base score (I10).
      type parent = name.
      type child = parent, name, score.
      extend child with is high scorer = score >= 100.
      extend parent with high scorer name = some child its name where is high scorer per parent.
    `

    const schema = await parseAndGenerate(source)

    // Should generate view for the high scorer name extend
    expect(schema).toContain(
      'export const parentItsHighScorerName = sqliteView("parent_its_high_scorer_name", {',
    )
    expect(schema).toContain(
      'highScorerName: text("high_scorer_name", { length: 1024 }),',
    )

    // Should have scalar subquery selecting name with WHERE clause from joined view, including soft delete filter
    expect(schema).toContain("select child.name from child")
    expect(schema).toContain("join child_its_is_high_scorer")
    expect(schema).toContain("where child.parent_id = parent.id")
    expect(schema).toContain("and child_its_is_high_scorer.is_high_scorer = 1")
    expect(schema).toContain("and child._deleted = false")
    expect(schema).toContain("limit 1")
  })

  it("should generate views for count function", async () => {
    const source = `
      base name (A64).
      type invoice = name.
      type invoice line = invoice, name.
      extend invoice with linecount = count invoice line per invoice.
    `

    const schema = await parseAndGenerate(source)

    // Should import sqliteView and sql
    expect(schema).toContain('import { sql } from "drizzle-orm"')
    expect(schema).toContain("sqliteView")

    // Should have comment for views
    expect(schema).toContain("// Views for virtual attributes")

    // Should generate the view
    expect(schema).toContain(
      'export const invoiceItsLinecount = sqliteView("invoice_its_linecount", {',
    )
    expect(schema).toContain('id: text("id", { length: 41 }).notNull(),')
    expect(schema).toContain('linecount: integer("linecount").notNull(),')
    expect(schema).toContain("}).as(sql`")

    // Should use JOINs with GROUP BY pattern (not subquery), including soft delete filter
    expect(schema).toContain("from invoice")
    expect(schema).toContain(
      "left outer join invoice_line on invoice_line.invoice_id = invoice.id and invoice_line._deleted = false",
    )
    // Count distinct child IDs (the actual records being counted)
    expect(schema).toContain("count(distinct invoice_line.id)")
    expect(schema).toContain("group by")
    expect(schema).toContain("invoice.id")
  })

  it("should generate views for count function with complex perPath", async () => {
    const source = `
      base name (A64).
      type grandparent = name.
      type parent = grandparent, name.
      type child = parent, name.
      extend grandparent with childcount = count child per parent its grandparent.
    `

    const schema = await parseAndGenerate(source)

    // Should generate the view
    expect(schema).toContain(
      'export const grandparentItsChildcount = sqliteView("grandparent_its_childcount", {',
    )
    expect(schema).toContain('childcount: integer("childcount").notNull(),')

    // Should use JOINs from grandparent -> parent -> child with GROUP BY, including soft delete filters
    expect(schema).toContain("from grandparent")
    expect(schema).toContain(
      "left outer join parent on parent.grandparent_id = grandparent.id and parent._deleted = false",
    )
    expect(schema).toContain(
      "left outer join child on child.parent_id = parent.id and child._deleted = false",
    )
    // Count distinct child IDs (the actual records being counted)
    expect(schema).toContain("count(distinct child.id)")
    expect(schema).toContain("group by")
    expect(schema).toContain("grandparent.id")
  })

  it("should generate views for total function", async () => {
    const source = `
      base name (A64).
      base amount (R10,2).
      type invoice = name.
      type invoice line = invoice, amount.
      extend invoice with invoicesum = total invoice line its amount per invoice.
    `

    const schema = await parseAndGenerate(source)

    // Should generate the view
    expect(schema).toContain(
      'export const invoiceItsInvoicesum = sqliteView("invoice_its_invoicesum", {',
    )
    expect(schema).toContain('id: text("id", { length: 41 }).notNull(),')
    expect(schema).toContain('invoicesum: real("invoicesum"),')
    expect(schema).toContain("}).as(sql`")

    // Should use SUM with JOINs and GROUP BY, including soft delete filter
    expect(schema).toContain("from invoice")
    expect(schema).toContain(
      "left outer join invoice_line on invoice_line.invoice_id = invoice.id and invoice_line._deleted = false",
    )
    expect(schema).toContain("sum(invoice_line.amount)")
    expect(schema).toContain("group by")
    expect(schema).toContain("invoice.id")
  })

  it("should generate views for min function", async () => {
    const source = `
      base name (A64).
      base price (R10,2).
      type category = name.
      type product = category, price.
      extend category with lowest price = min product its price per category.
    `

    const schema = await parseAndGenerate(source)

    // Should generate the view
    expect(schema).toContain(
      'export const categoryItsLowestPrice = sqliteView("category_its_lowest_price", {',
    )
    expect(schema).toContain('lowestPrice: real("lowest_price"),')

    // Should use MIN with JOINs and GROUP BY, including soft delete filter
    expect(schema).toContain("from category")
    expect(schema).toContain(
      "left outer join product on product.category_id = category.id and product._deleted = false",
    )
    expect(schema).toContain("min(product.price)")
    expect(schema).toContain("group by")
  })

  it("should generate views for max function", async () => {
    const source = `
      base name (A64).
      base score (I10).
      type team = name.
      type player = team, score.
      extend team with high score = max player its score per team.
    `

    const schema = await parseAndGenerate(source)

    // Should generate the view
    expect(schema).toContain(
      'export const teamItsHighScore = sqliteView("team_its_high_score", {',
    )
    expect(schema).toContain('highScore: real("high_score"),')

    // Should use MAX with JOINs and GROUP BY, including soft delete filter
    expect(schema).toContain("from team")
    expect(schema).toContain(
      "left outer join player on player.team_id = team.id and player._deleted = false",
    )
    expect(schema).toContain("max(player.score)")
    expect(schema).toContain("group by")
  })

  it("should generate views for total function with complex perPath", async () => {
    const source = `
      base name (A64).
      base amount (R10,2).
      type customer = name.
      type invoice = customer, name.
      type invoice line = invoice, amount.
      extend customer with amount spent = total invoice line its amount per invoice its customer.
    `

    const schema = await parseAndGenerate(source)

    // Should generate the view with proper JOINs through the chain, including soft delete filters
    expect(schema).toContain(
      'export const customerItsAmountSpent = sqliteView("customer_its_amount_spent", {',
    )
    expect(schema).toContain("from customer")
    expect(schema).toContain(
      "left outer join invoice on invoice.customer_id = customer.id and invoice._deleted = false",
    )
    expect(schema).toContain(
      "left outer join invoice_line on invoice_line.invoice_id = invoice.id and invoice_line._deleted = false",
    )
    expect(schema).toContain("sum(invoice_line.amount)")
    expect(schema).toContain("group by")
    expect(schema).toContain("customer.id")
  })

  it("should handle JSON columns with customType", async () => {
    const source = `
      base config (J).
      type settings = config.
    `

    const schema = await parseAndGenerate(source)

    // Check for customType import
    expect(schema).toContain("import { customType")
    expect(schema).toContain('from "drizzle-orm/sqlite-core"')

    // Check for jsonColumn definition
    expect(schema).toContain(
      "const jsonColumn = customType<{ data: Record<string, unknown> | unknown[]; driverData: string | null }>",
    )

    // Check column uses jsonColumn()
    expect(schema).toContain('config: jsonColumn("config").notNull()')

    // Should NOT use old text with mode: json pattern
    expect(schema).not.toContain('mode: "json"')
  })

  it("should handle optional JSON columns", async () => {
    const source = `
      base metadata (J).
      type document = optional metadata.
    `

    const schema = await parseAndGenerate(source)

    // Optional JSON should be nullable (no .notNull())
    expect(schema).toContain('metadata: jsonColumn("metadata"),')
    expect(schema).not.toContain('metadata: jsonColumn("metadata").notNull()')
  })

  it("should mix JSON columns with other types", async () => {
    const source = `
      base name (A64).
      base config (J).
      base active (B).
      type entity = name, config, active.
    `

    const schema = await parseAndGenerate(source)

    // Should have both customType and other column type imports
    expect(schema).toContain("import { customType")
    expect(schema).toContain("text")
    expect(schema).toContain("integer")

    // All columns should be present
    expect(schema).toContain('name: text("name", { length: 64 }).notNull()')
    expect(schema).toContain('config: jsonColumn("config").notNull()')
    expect(schema).toContain(
      'active: integer("active", { mode: "boolean" }).notNull()',
    )
  })
})

describe("generateTriggerSQL (SQLite)", () => {
  const parseDDL = async (source: string) => Effect.runPromise(parse(source))

  it("should generate trigger for single table", async () => {
    const source = `
      base name (A64).
      type customer = name.
    `
    const program = await parseDDL(source)
    const triggers = generateTriggerSQL(program, "test.ddl")

    // Should have header comments
    expect(triggers).toContain("-- Generated from Xplain DDL: test.ddl")
    expect(triggers).toContain(
      "-- Auto-generated triggers for updated_at columns",
    )
    expect(triggers).toContain("-- DO NOT EDIT")

    // Should have trigger for customer table
    expect(triggers).toContain(
      "CREATE TRIGGER IF NOT EXISTS customer_updated_at_trigger",
    )
    expect(triggers).toContain('AFTER UPDATE ON "customer"')
    expect(triggers).toContain("FOR EACH ROW")
    expect(triggers).toContain("WHEN NEW.updated_at = OLD.updated_at")
    expect(triggers).toContain("BEGIN")
    expect(triggers).toContain(
      "  UPDATE \"customer\" SET updated_at = julianday('now') WHERE id = NEW.id;",
    )
    expect(triggers).toContain("END;")

    // Should NOT have statement breakpoint for single trigger
    expect(triggers).not.toContain("--> statement-breakpoint")
  })

  it("should generate triggers for multiple tables with statement breakpoints", async () => {
    const source = `
      base name (A64).
      type customer = name.
      type product = name.
      type invoice = customer.
    `
    const program = await parseDDL(source)
    const triggers = generateTriggerSQL(program, "test.ddl")

    // Should have triggers for all three tables
    expect(triggers).toContain(
      "CREATE TRIGGER IF NOT EXISTS customer_updated_at_trigger",
    )
    expect(triggers).toContain(
      "CREATE TRIGGER IF NOT EXISTS product_updated_at_trigger",
    )
    expect(triggers).toContain(
      "CREATE TRIGGER IF NOT EXISTS invoice_updated_at_trigger",
    )

    // Should have statement breakpoints between triggers
    const breakpoints = triggers.match(/--> statement-breakpoint/g)
    expect(breakpoints).not.toBeNull()
    expect(breakpoints?.length).toBe(2) // 2 breakpoints for 3 triggers

    // Verify breakpoints are positioned correctly (not after the last trigger)
    const lastTriggerEnd = triggers.lastIndexOf("END;")
    const lastBreakpoint = triggers.lastIndexOf("--> statement-breakpoint")
    expect(lastBreakpoint).toBeLessThan(lastTriggerEnd)
  })

  it("should handle multi-word table names with snake_case", async () => {
    const source = `
      base name (A64).
      type invoice line = name.
    `
    const program = await parseDDL(source)
    const triggers = generateTriggerSQL(program, "test.ddl")

    expect(triggers).toContain(
      "CREATE TRIGGER IF NOT EXISTS invoice_line_updated_at_trigger",
    )
    expect(triggers).toContain('AFTER UPDATE ON "invoice_line"')
    expect(triggers).toContain(
      "  UPDATE \"invoice_line\" SET updated_at = julianday('now') WHERE id = NEW.id;",
    )
  })

  it("should use AFTER UPDATE timing (not BEFORE UPDATE)", async () => {
    const source = `
      base name (A64).
      type customer = name.
    `
    const program = await parseDDL(source)
    const triggers = generateTriggerSQL(program, "test.ddl")

    // MUST use AFTER UPDATE because SQLite doesn't support direct assignment in BEFORE triggers
    expect(triggers).toContain('AFTER UPDATE ON "customer"')
    expect(triggers).not.toContain("BEFORE UPDATE")
  })

  it("should have WHEN clause to prevent infinite recursion", async () => {
    const source = `
      base name (A64).
      type customer = name.
    `
    const program = await parseDDL(source)
    const triggers = generateTriggerSQL(program, "test.ddl")

    // WHEN clause ensures trigger only fires when updated_at hasn't been explicitly changed
    // This prevents infinite recursion when the nested UPDATE executes
    expect(triggers).toContain("WHEN NEW.updated_at = OLD.updated_at")
  })

  it("should use julianday for SQLite timestamps", async () => {
    const source = `
      base name (A64).
      type customer = name.
    `
    const program = await parseDDL(source)
    const triggers = generateTriggerSQL(program, "test.ddl")

    // SQLite uses julianday('now') instead of NOW() or CURRENT_TIMESTAMP
    expect(triggers).toContain("julianday('now')")
    expect(triggers).not.toContain("NOW()")
    expect(triggers).not.toContain("CURRENT_TIMESTAMP")
  })

  it("should target row by id column", async () => {
    const source = `
      base name (A64).
      type customer = name.
    `
    const program = await parseDDL(source)
    const triggers = generateTriggerSQL(program, "test.ddl")

    // Nested UPDATE uses WHERE id = NEW.id to target the specific row
    expect(triggers).toContain("WHERE id = NEW.id;")
  })

  it("should generate consistent trigger structure across all tables", async () => {
    const source = `
      base name (A64).
      type customer = name.
      type product = name.
    `
    const program = await parseDDL(source)
    const triggers = generateTriggerSQL(program, "test.ddl")

    // Both triggers should have identical structure
    const customerTriggerPattern =
      /CREATE TRIGGER IF NOT EXISTS customer_updated_at_trigger\nAFTER UPDATE ON "customer"\nFOR EACH ROW\nWHEN NEW\.updated_at = OLD\.updated_at\nBEGIN\n {2}UPDATE "customer" SET updated_at = julianday\('now'\) WHERE id = NEW\.id;\nEND;/
    const productTriggerPattern =
      /CREATE TRIGGER IF NOT EXISTS product_updated_at_trigger\nAFTER UPDATE ON "product"\nFOR EACH ROW\nWHEN NEW\.updated_at = OLD\.updated_at\nBEGIN\n {2}UPDATE "product" SET updated_at = julianday\('now'\) WHERE id = NEW\.id;\nEND;/

    expect(triggers).toMatch(customerTriggerPattern)
    expect(triggers).toMatch(productTriggerPattern)
  })

  it("should prefix SQL table names when prefix is provided", async () => {
    const source = `
      base name (A64).
      type customer = name.
    `

    const schema = await parseAndGenerate(source, "pf_")

    // SQL table name should be prefixed
    expect(schema).toContain(
      'export const customer = sqliteTable("pf_customer"',
    )

    // TypeScript identifier should NOT be prefixed
    expect(schema).toContain("export const customer")
    expect(schema).not.toContain("export const pfCustomer")
  })

  it("should prefix index names when prefix is provided", async () => {
    const source = `
      base name (A64).
      type customer = name.
      index customer its name_idx = name.
    `

    const schema = await parseAndGenerate(source, "pf_")

    // Index name should be prefixed
    expect(schema).toContain('nameIdxIdx: index("pf_customer_name_idx_idx")')
  })

  it("should prefix view names when prefix is provided", async () => {
    const source = `
      base name (A1024).
      type parent = name.
      type child = parent.
      extend parent with has children = any child per parent.
    `

    const schema = await parseAndGenerate(source, "pf_")

    // View SQL name should be prefixed
    expect(schema).toContain(
      'export const parentItsHasChildren = sqliteView("pf_parent_its_has_children"',
    )

    // View SQL should reference prefixed table names
    expect(schema).toContain("from pf_parent")
    expect(schema).toContain("from pf_child")
  })

  it("should prefix trigger table names when prefix is provided", async () => {
    const source = `
      base name (A64).
      type customer = name.
    `

    const { parse } = await import("@pf/xplain-ddl")
    const { generateTriggerSQL } = await import("./generator.sqlite.js")

    const ast = await Effect.runPromise(parse(source))
    const triggerSQL = generateTriggerSQL(ast, "test.ddl", "pf_")

    // Trigger should reference prefixed table name
    expect(triggerSQL).toContain('AFTER UPDATE ON "pf_customer"')
    expect(triggerSQL).toContain(
      "CREATE TRIGGER IF NOT EXISTS pf_customer_updated_at_trigger",
    )
  })
})
