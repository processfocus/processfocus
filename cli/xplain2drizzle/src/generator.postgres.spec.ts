import { Effect } from "effect"
import { parse } from "@pf/xplain-ddl"
import { generateDrizzleSchema } from "./generator.postgres.js"
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

describe("generateDrizzleSchema", () => {
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

    expect(schema).toContain('from "drizzle-orm/pg-core"')
    expect(schema).toContain('import { sql } from "drizzle-orm"')
    expect(schema).toContain('import { DateTime } from "effect"')
    expect(schema).toContain("export const customer = pgTable")
    expect(schema).toContain(
      'id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => ulid())',
    )
    expect(schema).toContain('name: varchar("name", { length: 64 }).notNull()')
    expect(schema).toContain('active: boolean("active").notNull()')
    expect(schema).toContain(
      'createdAt: effectDateTime("created_at").notNull().default(sql`now()`)',
    )
    expect(schema).toContain(
      'updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`)',
    )
    expect(schema).toContain(
      'createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM")',
    )
    expect(schema).toContain(
      'updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM")',
    )
    expect(schema).toContain(
      '_deleted: boolean("_deleted").notNull().default(false)',
    )
  })

  it("should handle optional attributes", async () => {
    const source = `
      base description (T).
      type product = optional description.
    `

    const schema = await parseAndGenerate(source)

    expect(schema).toContain('description: citext("description"),')
    expect(schema).not.toContain('description: citext("description").notNull()')
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
      'textField: varchar("text_field", { length: 100 }).notNull()',
    )
    expect(schema).toContain('boolFlag: boolean("bool_flag").notNull()')
    expect(schema).toContain(
      'datetimeTimestamp: effectDateTime("datetime_timestamp").notNull()',
    )
    expect(schema).toContain('intNumber: integer("int_number").notNull()')
    expect(schema).toContain(
      'realDecimal: numeric("real_decimal", { precision: 12, scale: 2 }).notNull()',
    )
    expect(schema).toContain('longLongtext: citext("long_longtext").notNull()')
    expect(schema).toContain(
      'urnIdentifier: varchar("urn_identifier", { length: 255 }).notNull()',
    )
  })

  it("should handle case-insensitive text type (C)", async () => {
    const source = `
      base name (C256).

      type person = name.
    `

    const schema = await parseAndGenerate(source)

    // Should use citext custom type
    expect(schema).toContain('name: citext("name").notNull()')

    // Should include custom type definition
    expect(schema).toContain("const citext = customType")
    expect(schema).toContain('return "citext"')

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

  it("should escape static assert string literals in generated templates", async () => {
    const source = `
      base code (A64).
      type token = code.
      assert token its safe code (true) = code != "bad \` \${ value".
    `

    const schema = await parseAndGenerate(source)

    expect(schema).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing generated template string
      "safeCodeCheck: check(\"safe_code_check\", sql`${table.code} != 'bad \\` \\${ value'`)",
    )
  })

  it("should handle multi-word identifiers", async () => {
    const source = `
      base name (A64).
      type invoice line = name.
    `

    const schema = await parseAndGenerate(source)

    expect(schema).toContain(
      'export const invoiceLine = pgTable("invoice_line"',
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
      'customerId: varchar("customer_id", { length: 41 }).notNull().references(() => customer.id)',
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
      'sourceStepId: varchar("source_step", { length: 41 }).notNull().references(() => step.id)',
    )
    expect(schema).toContain(
      'targetStepId: varchar("target_step", { length: 41 }).notNull().references(() => step.id)',
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
      'id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `cust-${ulid()}`)',
    )
  })

  it("should generate ID without prefix when type has no idPrefix", async () => {
    const source = `
      base name (A64).
      type customer = name.
    `

    const schema = await parseAndGenerate(source)

    expect(schema).toContain(
      'id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => ulid())',
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

    // Should import AnyPgColumn as type-only import for self-references
    expect(schema).toContain("import type { AnyPgColumn }")

    // Column should be nullable (no .notNull()) and have explicit return type
    expect(schema).toContain(
      'parentOrgUnitId: varchar("parent_org_unit", { length: 41 }).references((): AnyPgColumn => orgUnit.id)',
    )
    expect(schema).not.toContain(
      'parentOrgUnitId: varchar("parent_org_unit", { length: 41 }).notNull()',
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

    // Should import pgView and sql
    expect(schema).toContain('import { sql } from "drizzle-orm"')
    expect(schema).toContain("pgView")

    // Should have comment for views
    expect(schema).toContain("// Views for virtual attributes")

    // Should generate the view
    expect(schema).toContain(
      'export const parentItsHasNoChildren = pgView("parent_its_has_no_children", {',
    )
    expect(schema).toContain('id: varchar("id", { length: 41 }).notNull(),')
    expect(schema).toContain(
      'hasNoChildren: boolean("has_no_children").notNull(),',
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

    // Should import pgView and sql
    expect(schema).toContain('import { sql } from "drizzle-orm"')
    expect(schema).toContain("pgView")

    // Should have comment for views
    expect(schema).toContain("// Views for virtual attributes")

    // Should generate the view
    expect(schema).toContain(
      'export const parentItsHasChildren = pgView("parent_its_has_children", {',
    )
    expect(schema).toContain('id: varchar("id", { length: 41 }).notNull(),')
    expect(schema).toContain('hasChildren: boolean("has_children").notNull(),')
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

    // Should import pgView and sql
    expect(schema).toContain('import { sql } from "drizzle-orm"')
    expect(schema).toContain("pgView")

    // Should have comment for views
    expect(schema).toContain("// Views for virtual attributes")

    // Should generate the view
    expect(schema).toContain(
      'export const parentItsSomescore = pgView("parent_its_somescore", {',
    )
    expect(schema).toContain('id: varchar("id", { length: 41 }).notNull(),')
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

    // Should import pgView and sql
    expect(schema).toContain('import { sql } from "drizzle-orm"')
    expect(schema).toContain("pgView")

    // Should generate the view with varchar type for foreign key
    expect(schema).toContain(
      'export const parentItsSomefriend = pgView("parent_its_somefriend", {',
    )
    expect(schema).toContain('id: varchar("id", { length: 41 }).notNull(),')
    expect(schema).toContain(
      'somefriend: varchar("somefriend", { length: 41 }),',
    )

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
      'export const grandparentItsSomevalue = pgView("grandparent_its_somevalue", {',
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

    // Should import pgView and sql
    expect(schema).toContain('import { sql } from "drizzle-orm"')
    expect(schema).toContain("pgView")

    // Should have comment for views
    expect(schema).toContain("// Views for virtual attributes")

    // Should generate the view (assert is treated like extend)
    expect(schema).toContain(
      'export const parentItsHasChildren = pgView("parent_its_has_children", {',
    )
    expect(schema).toContain('id: varchar("id", { length: 41 }).notNull(),')
    expect(schema).toContain('hasChildren: boolean("has_children").notNull(),')
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

    // Should import pgView and sql
    expect(schema).toContain('import { sql } from "drizzle-orm"')
    expect(schema).toContain("pgView")

    // Should generate view for the can start process extend
    expect(schema).toContain(
      'export const stepItsCanStartProcess = pgView("step_its_can_start_process"',
    )

    // Should generate view for the start step extend
    expect(schema).toContain(
      'export const processItsStartStep = pgView("process_its_start_step", {',
    )
    expect(schema).toContain('id: varchar("id", { length: 41 }).notNull(),')
    expect(schema).toContain(
      'startStep: varchar("start_step", { length: 41 }),',
    )
    expect(schema).toContain("}).as(sql`")

    // Should have scalar subquery selecting id with WHERE clause from joined view, including soft delete filter
    expect(schema).toContain("select step.id from step")
    expect(schema).toContain("join step_its_can_start_process")
    expect(schema).toContain("where step.process_id = process.id")
    expect(schema).toContain(
      "and step_its_can_start_process.can_start_process = true",
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
      'export const parentItsHighScorerName = pgView("parent_its_high_scorer_name", {',
    )
    expect(schema).toContain(
      'highScorerName: varchar("high_scorer_name", { length: 1024 }),',
    )

    // Should have scalar subquery selecting name with WHERE clause from joined view, including soft delete filter
    expect(schema).toContain("select child.name from child")
    expect(schema).toContain("join child_its_is_high_scorer")
    expect(schema).toContain("where child.parent_id = parent.id")
    expect(schema).toContain(
      "and child_its_is_high_scorer.is_high_scorer = true",
    )
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

    // Should import pgView and sql
    expect(schema).toContain('import { sql } from "drizzle-orm"')
    expect(schema).toContain("pgView")

    // Should have comment for views
    expect(schema).toContain("// Views for virtual attributes")

    // Should generate the view
    expect(schema).toContain(
      'export const invoiceItsLinecount = pgView("invoice_its_linecount", {',
    )
    expect(schema).toContain('id: varchar("id", { length: 41 }).notNull(),')
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
      'export const grandparentItsChildcount = pgView("grandparent_its_childcount", {',
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
      'export const invoiceItsInvoicesum = pgView("invoice_its_invoicesum", {',
    )
    expect(schema).toContain('id: varchar("id", { length: 41 }).notNull(),')
    expect(schema).toContain('invoicesum: numeric("invoicesum"),')
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
      'export const categoryItsLowestPrice = pgView("category_its_lowest_price", {',
    )
    expect(schema).toContain('lowestPrice: numeric("lowest_price"),')

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
      'export const teamItsHighScore = pgView("team_its_high_score", {',
    )
    expect(schema).toContain('highScore: numeric("high_score"),')

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
      'export const customerItsAmountSpent = pgView("customer_its_amount_spent", {',
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

  it("should prefix SQL table names when prefix is provided", async () => {
    const source = `
      base name (A64).
      type customer = name.
    `

    const schema = await parseAndGenerate(source, "pf_")

    // SQL table name should be prefixed
    expect(schema).toContain('export const customer = pgTable("pf_customer"')

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
      'export const parentItsHasChildren = pgView("pf_parent_its_has_children"',
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
    const { generateTriggerSQL } = await import("./generator.postgres.js")

    const ast = await Effect.runPromise(parse(source))
    const triggerSQL = generateTriggerSQL(ast, "test.ddl", "pf_")

    // Trigger should reference prefixed table name
    expect(triggerSQL).toContain('BEFORE UPDATE ON "pf_customer"')
    expect(triggerSQL).toContain(
      "CREATE TRIGGER pf_customer_updated_at_trigger",
    )
  })
})
