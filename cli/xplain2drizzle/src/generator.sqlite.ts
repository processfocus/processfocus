import { Data, Effect } from "effect"
import type {
  AttributeNode,
  DataType,
  ExpressionNode,
  IndexNode,
  Program,
  TypeDeclaration,
} from "@pf/xplain-ddl"
import {
  ID_COLUMN_LENGTH,
  generateAggregateViewBody,
  generateCheckConstraintSql,
  generateCountViewBody,
  generateExistsSubquery,
  generateIndexName,
  generateRelations,
  generateScalarSubquery,
  generateScalarSubqueryWithWhere,
  generateTypeExports,
  toCamelCase,
  toSnakeCase,
  toTableName,
} from "./generator.shared.js"

/**
 * Generator error types
 */
class UnknownBaseTypeError extends Data.TaggedError("UnknownBaseType")<{
  readonly attribute: string
  readonly baseName: string
}> {}

class InvalidTypeReferenceError extends Data.TaggedError(
  "InvalidTypeReference",
)<{
  readonly attribute: string
  readonly typeName: string
}> {}

type GeneratorError = UnknownBaseTypeError | InvalidTypeReferenceError

/**
 * Map Xplain data type to Drizzle SQLite column definition
 */
const mapDataType = (
  columnName: string,
  dataType: DataType,
  notNull: boolean,
): string => {
  let columnDef: string

  switch (dataType.type) {
    case "text":
      columnDef = `text("${toSnakeCase(columnName)}", { length: ${dataType.maxLength} })`
      break
    case "boolean":
      // SQLite stores booleans as integers (0/1)
      columnDef = `integer("${toSnakeCase(columnName)}", { mode: "boolean" })`
      break
    case "citext":
      columnDef = `citextColumn("${toSnakeCase(columnName)}")`
      break
    case "datetime":
      columnDef = `effectDateTime("${toSnakeCase(columnName)}")`
      break
    case "integer":
      columnDef = `integer("${toSnakeCase(columnName)}")`
      break
    case "json":
      columnDef = `jsonColumn("${toSnakeCase(columnName)}")`
      break
    case "real":
      // SQLite's real type doesn't support precision/scale, but we can store the info as a comment
      columnDef = `real("${toSnakeCase(columnName)}")`
      break
    case "unlimited_text":
      columnDef = `citextColumn("${toSnakeCase(columnName)}")`
      break
    case "urn":
      columnDef = `text("${toSnakeCase(columnName)}", { length: 255 })`
      break
  }

  if (notNull) {
    columnDef += ".notNull()"
  }

  return columnDef
}

/**
 * Result of generating a default expression.
 * - useSql: true means wrap in sql`...`, false means use plain .default(value)
 * - value: the expression to use
 */
type DefaultExpressionResult = {
  useSql: boolean
  value: string
} | null

/**
 * Generate default value expression
 */
const generateDefaultExpression = (
  expr: ExpressionNode,
): DefaultExpressionResult => {
  if (expr.kind === "literal") {
    if (expr.valueType === "string") {
      // String literals don't need sql template - use plain .default("value")
      return { useSql: false, value: `"${expr.value}"` }
    } else if (expr.valueType === "systemdate") {
      // SQL functions need sql template, wrapped in parens for SQLite DEFAULT
      return { useSql: true, value: "(julianday('now'))" }
    } else if (expr.valueType === "boolean") {
      return { useSql: false, value: String(expr.value) }
    } else {
      // Numbers don't need sql template
      return { useSql: false, value: String(expr.value) }
    }
  }
  // For now, only support literal defaults (Phase 1)
  return null
}

/**
 * Generate a single column definition
 */
const generateColumn = (
  attr: AttributeNode,
  baseMap: Map<string, DataType>,
  typeMap: Map<string, TypeDeclaration>,
  currentType: TypeDeclaration,
): Effect.Effect<string, GeneratorError> =>
  Effect.gen(function* () {
    const camelName = toCamelCase(attr.name)
    const notNull = !attr.optional

    // Check if this is a type reference (foreign key)
    const referencedType = typeMap.get(attr.baseName)
    if (referencedType) {
      // This is a foreign key - length matches ID column
      const columnName =
        attr.baseName === attr.name
          ? `${toSnakeCase(attr.name)}_id`
          : `${toSnakeCase(attr.name)}`
      let columnDef = `text("${columnName}", { length: ${ID_COLUMN_LENGTH} })`

      // Self-references must always be nullable (can't insert first row otherwise)
      const isSelfReference = referencedType.name === currentType.name
      if (notNull && !isSelfReference) {
        columnDef += ".notNull()"
      }

      // Self-references need explicit type annotation to avoid TS7022/TS7024 errors
      if (isSelfReference) {
        columnDef += `.references((): AnySQLiteColumn => ${toCamelCase(referencedType.name)}.id)`
      } else {
        columnDef += `.references(() => ${toCamelCase(referencedType.name)}.id)`
      }

      return `  ${camelName}Id: ${columnDef},`
    }

    // Regular attribute - look up the base type
    const dataType = baseMap.get(attr.baseName)
    if (!dataType) {
      return yield* new UnknownBaseTypeError({
        attribute: attr.name,
        baseName: attr.baseName,
      })
    }

    let columnDef = mapDataType(attr.name, dataType, notNull)

    let comment = ""

    // Add default value if present
    if (attr.default) {
      const defaultExpr = generateDefaultExpression(attr.default)
      if (defaultExpr) {
        if (defaultExpr.useSql) {
          columnDef += `.default(sql\`${defaultExpr.value}\`)`
        } else {
          columnDef += `.default(${defaultExpr.value})`
        }
      } else {
        comment = " // TODO: Complex default expression not yet supported"
      }
    }

    // Add init value if present (with comment)
    if (attr.init) {
      const initExpr = generateDefaultExpression(attr.init)
      if (initExpr) {
        if (initExpr.useSql) {
          columnDef += `.default(sql\`${initExpr.value}\`)`
        } else {
          columnDef += `.default(${initExpr.value})`
        }
        comment = " // Init value (cannot be overridden on insert)"
      } else {
        comment = " // TODO: Complex init expression not yet supported"
      }
    }

    return `  ${camelName}: ${columnDef},${comment}`
  })

/**
 * Generate index and constraint definitions
 */
const generateIndexes = (
  type: TypeDeclaration,
  indexes: IndexNode[],
  uniqueIndexes: IndexNode[],
  typeMap: Map<string, TypeDeclaration>,
  baseMap: Map<string, DataType>,
  prefix = "",
): string => {
  // Always generate indexes section (at minimum, the automatic updated_at_id index)
  const indexDefs: string[] = []

  // Tables that should not have soft delete WHERE clause on their unique indexes
  // oauth_storage needs a full unique constraint for ON CONFLICT upsert operations
  const SKIP_SOFT_DELETE_TABLES = new Set(["oauth storage"])
  const skipSoftDelete = SKIP_SOFT_DELETE_TABLES.has(type.name)

  // Helper to get the actual column name (accounting for foreign keys)
  const getColumnRef = (attrName: string): string => {
    const attr = type.attributes.find((a) => a.name === attrName)
    if (!attr) {
      return `table.${toCamelCase(attrName)}`
    }

    // Check if this is a foreign key reference
    const referencedType = typeMap.get(attr.baseName)
    if (referencedType) {
      return `table.${toCamelCase(attrName)}Id`
    }

    return `table.${toCamelCase(attrName)}`
  }

  for (const idx of indexes) {
    const indexName = generateIndexName(type.name, idx.name, prefix)
    const columns = idx.attributes.map(getColumnRef).join(", ")
    const whereClause = skipSoftDelete ? "" : ".where(sql`_deleted = 0`)"
    indexDefs.push(
      `  ${toCamelCase(idx.name)}Idx: index("${indexName}").on(${columns})${whereClause},`,
    )
  }

  for (const idx of uniqueIndexes) {
    const indexName = generateIndexName(type.name, idx.name, prefix)
    const columns = idx.attributes.map(getColumnRef).join(", ")
    const whereClause = skipSoftDelete ? "" : ".where(sql`_deleted = 0`)"
    indexDefs.push(
      `  ${toCamelCase(idx.name)}Idx: uniqueIndex("${indexName}").on(${columns})${whereClause},`,
    )
  }

  // Add automatic unique indexes for specialization foreign keys (1:0-1 relationships)
  for (const attr of type.attributes) {
    if (attr.isSpecialization) {
      const referencedType = typeMap.get(attr.baseName)
      if (referencedType) {
        const columnRef = `table.${toCamelCase(attr.name)}Id`
        const indexName = `${toTableName(type.name, prefix)}_${toSnakeCase(attr.name)}_unique_idx`
        const whereClause = skipSoftDelete ? "" : ".where(sql`_deleted = 0`)"
        indexDefs.push(
          `  ${toCamelCase(attr.name)}UniqueIdx: uniqueIndex("${indexName}").on(${columnRef})${whereClause},`,
        )
      }
    }
  }

  // Add automatic index for RxDB cursor-based pagination (updated_at, id)
  // No WHERE clause - RxDB needs to track all changes including deletions
  const updatedAtIdxName = `${toTableName(type.name, prefix)}_updated_at_id_idx`
  indexDefs.push(
    `  updatedAtIdIdx: index("${updatedAtIdxName}").on(table.updatedAt, table.id),`,
  )

  // Add CHECK constraints for citext columns to enforce maxLength
  for (const attr of type.attributes) {
    const dataType = baseMap.get(attr.baseName)
    if (dataType && dataType.type === "citext") {
      const camelName = toCamelCase(attr.name)
      const snakeName = toSnakeCase(attr.name)
      const checkName = `${snakeName}_length_check`
      const constraintKey = `${camelName}LengthCheck`
      // Match drizzle-kit snapshot SQL to avoid no-op length-check migrations.
      const qualifiedColumn = `"${toTableName(type.name, prefix)}"."${snakeName}"`
      indexDefs.push(
        `  ${constraintKey}: check("${checkName}", sql.raw(\`length(${qualifiedColumn}) <= ${dataType.maxLength}\`)),`,
      )
    }
  }

  // Static assert checks already round-trip in drizzle-kit snapshots. Length
  // checks above use raw SQL because drizzle-kit snapshots those differently.
  for (const assertion of type.asserts) {
    const checkName = `${toSnakeCase(assertion.name)}_check`
    const constraintKey = `${toCamelCase(assertion.name)}Check`
    const constraintSql = generateCheckConstraintSql(
      assertion.expression,
      type,
      typeMap,
    )
    indexDefs.push(
      `  ${constraintKey}: check("${checkName}", sql\`${constraintSql}\`),`,
    )
  }

  return `, (table) => ({\n${indexDefs.join("\n")}\n})`
}

/**
 * Generate a table definition
 */
const generateTable = (
  type: TypeDeclaration,
  baseMap: Map<string, DataType>,
  typeMap: Map<string, TypeDeclaration>,
  prefix = "",
): Effect.Effect<string, GeneratorError> =>
  Effect.gen(function* () {
    const tableName = toTableName(type.name, prefix)
    const constName = toCamelCase(type.name)

    // Generate ID column with optional prefix
    const idColumn = type.idPrefix
      ? `  id: text("id", { length: ${ID_COLUMN_LENGTH} }).primaryKey().$defaultFn(() => \`${type.idPrefix}-\${ulid()}\`),`
      : `  id: text("id", { length: ${ID_COLUMN_LENGTH} }).primaryKey().$defaultFn(() => ulid()),`

    const columns: string[] = [idColumn]

    for (const attr of type.attributes) {
      const column = yield* generateColumn(attr, baseMap, typeMap, type)
      columns.push(column)
    }

    // Add audit columns
    columns.push(
      "  createdAt: effectDateTime(\"created_at\").notNull().default(sql`(julianday('now'))`),",
    )
    columns.push(
      "  updatedAt: effectDateTime(\"updated_at\").notNull().default(sql`(julianday('now'))`),",
    )
    columns.push(
      '  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),',
    )
    columns.push(
      '  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),',
    )
    columns.push(
      '  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),',
    )

    const indexesPart = generateIndexes(
      type,
      type.indexes,
      type.uniqueIndexes,
      typeMap,
      baseMap,
      prefix,
    )

    return `export const ${constName} = sqliteTable("${tableName}", {\n${columns.join("\n")}\n}${indexesPart})\n`
  })

/**
 * Generate views for extend declarations (virtual attributes)
 */
const generateExtendViews = (
  program: Program,
  baseMap: Map<string, DataType>,
  typeMap: Map<string, TypeDeclaration>,
  prefix = "",
): string[] => {
  const views: string[] = []

  for (const type of program.types) {
    const tableName = toTableName(type.name, prefix)
    const tableConstName = toCamelCase(type.name)

    for (const extend of type.extends) {
      // Only handle retrieval functions for now
      if (extend.expression.kind !== "retrieval_function") {
        continue
      }

      const retrieval = extend.expression

      // Handle supported retrieval functions
      if (
        retrieval.function !== "nil" &&
        retrieval.function !== "any" &&
        retrieval.function !== "some" &&
        retrieval.function !== "count" &&
        retrieval.function !== "total" &&
        retrieval.function !== "min" &&
        retrieval.function !== "max"
      ) {
        continue
      }

      // Common view setup
      const viewName = `${tableName}_its_${toSnakeCase(extend.attributeName)}`
      const attrCamelCase = toCamelCase(extend.attributeName)
      const attrPascalCase =
        attrCamelCase.charAt(0).toUpperCase() + attrCamelCase.slice(1)
      const viewConstName = `${tableConstName}Its${attrPascalCase}`
      const virtualAttrName = toSnakeCase(extend.attributeName)

      // Check if perPath has segments
      if (retrieval.perPath.segments.length === 0) {
        continue // Skip if perPath is empty
      }

      if (retrieval.function === "nil" || retrieval.function === "any") {
        // Generate view for nil/any function (returns boolean)
        const subquery = generateExistsSubquery(
          tableName,
          retrieval.typeName,
          retrieval.perPath.segments,
          typeMap,
          "= false",
          prefix,
        )

        // Use "exists" for any, "not exists" for nil
        const existsClause =
          retrieval.function === "nil" ? "not exists" : "exists"

        // Generate the view definition
        const viewDef = `export const ${viewConstName} = sqliteView("${viewName}", {
  id: text("id", { length: ${ID_COLUMN_LENGTH} }).notNull(),
  ${attrCamelCase}: integer("${virtualAttrName}", { mode: "boolean" }).notNull(),
}).as(sql\`
  select
    id,
    ${existsClause} (${subquery}) as ${virtualAttrName}
  from ${tableName}
\`)
`
        views.push(viewDef)
      } else if (retrieval.function === "some") {
        // Generate view for some function (returns a value from the related table)
        // Supports three cases:
        // 1. some type its attribute per ... - has expression but no wherePredicate
        // 2. some type where predicate per ... - has wherePredicate but no expression (returns id)
        // 3. some type its attribute where predicate per ... - has both

        // Find the target type
        const targetType = typeMap.get(retrieval.typeName)
        if (!targetType) {
          continue
        }

        const childTableName = toTableName(retrieval.typeName, prefix)

        // Determine what column to select and the column definition for the view
        let columnName: string
        let columnDef: string

        if (retrieval.expression) {
          // Has 'its' clause - select the specified attribute
          // For now, we only support identifier expressions (simple attribute names)
          if (retrieval.expression.kind !== "identifier") {
            continue // Skip complex expressions for now
          }

          const attributeToSelect = retrieval.expression.name
          const targetAttr = targetType.attributes.find(
            (a) => a.name === attributeToSelect,
          )
          if (!targetAttr) {
            continue
          }

          // Determine the column name and data type
          const isTypeReference = typeMap.has(targetAttr.baseName)
          columnName = isTypeReference
            ? targetAttr.baseName === targetAttr.name
              ? `${toSnakeCase(targetAttr.name)}_id`
              : toSnakeCase(targetAttr.name)
            : toSnakeCase(targetAttr.name)

          // Prefix with table name for clarity in subquery
          columnName = `${childTableName}.${columnName}`

          // Generate column definition for the view
          if (isTypeReference) {
            // It's a foreign key
            columnDef = `text("${virtualAttrName}", { length: ${ID_COLUMN_LENGTH} })`
          } else {
            // It's a base type - look up the data type from baseMap
            const dataType = baseMap.get(targetAttr.baseName)
            if (!dataType) {
              continue // Skip if base type not found
            }

            // Map the data type (nullable = false because some returns null if no records)
            columnDef = mapDataType(extend.attributeName, dataType, false)
          }
        } else {
          // No 'its' clause - select the id (returns a reference to the type)
          columnName = `${childTableName}.id`
          columnDef = `text("${virtualAttrName}", { length: ${ID_COLUMN_LENGTH} })`
        }

        // Generate the scalar subquery
        let subquery: string
        if (retrieval.wherePredicate) {
          // Has 'where' clause - need to join with virtual attribute view
          // For now, we only support identifier expressions for the predicate
          if (retrieval.wherePredicate.kind !== "identifier") {
            continue // Skip complex predicates for now
          }

          const predicateName = retrieval.wherePredicate.name
          subquery = generateScalarSubqueryWithWhere({
            parentTableName: tableName,
            childTypeName: retrieval.typeName,
            columnToSelect: columnName,
            perPathSegments: retrieval.perPath.segments,
            typeMap,
            wherePredicateName: predicateName,
            prefix,
          })
        } else {
          // No 'where' clause - simple scalar subquery
          subquery = generateScalarSubquery(
            tableName,
            retrieval.typeName,
            columnName,
            retrieval.perPath.segments,
            typeMap,
            "= false",
            prefix,
          )
        }

        // Generate the view definition
        const viewDef = `export const ${viewConstName} = sqliteView("${viewName}", {
  id: text("id", { length: ${ID_COLUMN_LENGTH} }).notNull(),
  ${attrCamelCase}: ${columnDef},
}).as(sql\`
  select
    id,
    (${subquery}) as ${virtualAttrName}
  from ${tableName}
\`)
`
        views.push(viewDef)
      } else if (retrieval.function === "count") {
        // Generate view for count function using JOINs and GROUP BY for performance
        const viewBody = generateCountViewBody(
          tableName,
          retrieval.typeName,
          retrieval.perPath.segments,
          typeMap,
          virtualAttrName,
          "= false",
          prefix,
        )

        // Generate the view definition
        const viewDef = `export const ${viewConstName} = sqliteView("${viewName}", {
  id: text("id", { length: ${ID_COLUMN_LENGTH} }).notNull(),
  ${attrCamelCase}: integer("${virtualAttrName}").notNull(),
}).as(sql\`
  ${viewBody}
\`)
`
        views.push(viewDef)
      } else if (
        retrieval.function === "total" ||
        retrieval.function === "min" ||
        retrieval.function === "max"
      ) {
        // Generate view for aggregate functions (total/min/max) using JOINs and GROUP BY
        // These require an expression to aggregate on
        if (!retrieval.expression) {
          continue // Skip if no expression (shouldn't happen with valid DDL)
        }

        // For now, only support identifier expressions (simple attribute names)
        if (retrieval.expression.kind !== "identifier") {
          console.warn(
            `Warning: Skipping ${retrieval.function} function for "${extend.attributeName}" - complex expressions not yet supported`,
          )
          continue
        }

        const childTableName = toTableName(retrieval.typeName, prefix)
        const attributeName = retrieval.expression.name
        const aggregateColumn = `${childTableName}.${toSnakeCase(attributeName)}`

        // Map retrieval function to SQL aggregate
        const sqlFunction =
          retrieval.function === "total" ? "sum" : retrieval.function

        const viewBody = generateAggregateViewBody(
          tableName,
          retrieval.typeName,
          retrieval.perPath.segments,
          typeMap,
          virtualAttrName,
          aggregateColumn,
          sqlFunction,
          "= false",
          prefix,
        )

        // Determine the column type based on the aggregate function
        // total (sum) returns real, min/max return the same type as the source
        // For simplicity, use real for all numeric aggregates
        const columnDef = "real"

        // Generate the view definition
        const viewDef = `export const ${viewConstName} = sqliteView("${viewName}", {
  id: text("id", { length: ${ID_COLUMN_LENGTH} }).notNull(),
  ${attrCamelCase}: ${columnDef}("${virtualAttrName}"),
}).as(sql\`
  ${viewBody}
\`)
`
        views.push(viewDef)
      }
    }
  }

  return views
}

/**
 * Generate trigger SQL for automatic updated_at column updates
 *
 * SQLite Trigger Design Rationale:
 * ---------------------------------
 * We use AFTER UPDATE triggers with nested UPDATE statements because SQLite does NOT
 * support direct assignment to NEW columns in BEFORE triggers (unlike PostgreSQL).
 *
 * According to SQLite documentation (https://www.sqlite.org/lang_createtrigger.html):
 * "If a BEFORE UPDATE or BEFORE DELETE trigger modifies or deletes a row that was to
 * have been updated or deleted, then the result of the subsequent update or delete
 * operation is undefined."
 *
 * This means:
 * - We CANNOT use: BEFORE UPDATE + direct assignment (e.g., NEW.updated_at = julianday('now'))
 * - We MUST use: AFTER UPDATE + nested UPDATE statement
 *
 * Performance Considerations:
 * ---------------------------
 * The nested UPDATE statement does fire a second UPDATE event, but the WHEN clause
 * prevents infinite recursion:
 * 1. First UPDATE: User updates row, trigger fires, nested UPDATE sets updated_at
 * 2. Second UPDATE: Trigger fires again, but WHEN clause is false (NEW != OLD), so no action
 *
 * This creates a small performance overhead (one extra trigger evaluation per update),
 * but this is unavoidable in SQLite for automatic timestamp management.
 *
 * Behavior:
 * ---------
 * - If user explicitly sets updated_at in their UPDATE, that value is preserved (WHEN clause is false)
 * - If user doesn't set updated_at, it's automatically updated to current time (WHEN clause is true)
 */
export const generateTriggerSQL = (
  program: Program,
  sourceFile: string,
  prefix = "",
): string => {
  const lines: string[] = []

  lines.push(`-- Generated from Xplain DDL: ${sourceFile}`)
  lines.push("-- Auto-generated triggers for updated_at columns")
  lines.push("-- DO NOT EDIT")
  lines.push("")

  const types = program.types
  for (let i = 0; i < types.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: index access
    const type = types[i]!
    const tableName = toTableName(type.name, prefix)
    const triggerName = `${tableName}_updated_at_trigger`

    // Using AFTER UPDATE because SQLite doesn't support direct assignment in BEFORE triggers
    lines.push(`CREATE TRIGGER IF NOT EXISTS ${triggerName}`)
    lines.push(`AFTER UPDATE ON "${tableName}"`)
    lines.push("FOR EACH ROW")
    // WHEN clause prevents infinite recursion and preserves explicit timestamp updates
    lines.push("WHEN NEW.updated_at = OLD.updated_at")
    lines.push("BEGIN")
    // Nested UPDATE is the only way to modify the row in SQLite triggers
    lines.push(
      `  UPDATE "${tableName}" SET updated_at = julianday('now') WHERE id = NEW.id;`,
    )
    lines.push("END;")

    // Add statement breakpoint between triggers, but not after the last one
    if (i < types.length - 1) {
      lines.push("--> statement-breakpoint")
    }
  }

  return lines.join("\n")
}

/**
 * Generate the complete Drizzle schema file for SQLite
 */
export const generateDrizzleSchema = (
  program: Program,
  sourceFile: string,
  prefix = "",
): Effect.Effect<string, GeneratorError> =>
  Effect.gen(function* () {
    // Build a map of base names to data types
    const baseMap = new Map<string, DataType>()
    for (const base of program.bases) {
      baseMap.set(base.name, base.dataType)
    }

    // Build a map of type names to type declarations
    const typeMap = new Map<string, TypeDeclaration>()
    for (const type of program.types) {
      typeMap.set(type.name, type)
    }

    // Check if we have any extends that need views and track which aggregate types are used
    let needsViews = false
    let needsReal = false
    for (const type of program.types) {
      for (const extend of type.extends) {
        if (extend.expression.kind === "retrieval_function") {
          const fn = extend.expression.function
          if (
            fn === "nil" ||
            fn === "any" ||
            fn === "some" ||
            fn === "count" ||
            fn === "total" ||
            fn === "min" ||
            fn === "max"
          ) {
            needsViews = true
          }
          if (fn === "total" || fn === "min" || fn === "max") {
            needsReal = true
          }
        }
      }
    }

    // Determine which imports we need
    const imports = new Set<string>(["sqliteTable", "text", "integer"])

    // Check if we need customType for JSON columns
    let needsJsonColumn = false
    let needsCitextColumn = false
    for (const type of program.types) {
      for (const attr of type.attributes) {
        const dataType = baseMap.get(attr.baseName)
        if (dataType?.type === "json") {
          needsJsonColumn = true
          imports.add("customType")
        }
        if (dataType?.type === "citext") {
          needsCitextColumn = true
          imports.add("customType")
          imports.add("check") // For length check constraints
        }
      }
    }

    // All tables now have datetime audit columns (created_at, updated_at)
    const hasDateTimeColumns = program.types.length > 0

    if (hasDateTimeColumns) {
      imports.add("customType")
    }

    if (needsViews) {
      imports.add("sqliteView")
      imports.add("integer") // nil/any/count functions return boolean/integer
    }
    if (needsReal) {
      imports.add("real") // total/min/max functions return real
    }

    // Scan all attributes to determine what column types we need
    for (const type of program.types) {
      for (const attr of type.attributes) {
        const dataType = baseMap.get(attr.baseName)
        if (dataType) {
          switch (dataType.type) {
            case "text":
            case "urn":
              imports.add("text")
              break
            case "unlimited_text":
              needsCitextColumn = true
              imports.add("customType")
              break
            case "json":
              // JSON columns use customType, added earlier
              break
            case "boolean":
            case "integer":
              imports.add("integer")
              break
            case "datetime":
              // Custom type, handled separately
              break
            case "real":
              imports.add("real")
              break
          }
        }
      }

      // Always add index import (needed for automatic updated_at_id index on all tables)
      imports.add("index")
      if (type.uniqueIndexes.length > 0) {
        imports.add("uniqueIndex")
      }
      if (type.asserts.length > 0) {
        imports.add("check")
      }
      // Add uniqueIndex import if there are specializations
      if (
        type.attributes.some(
          (attr) => attr.isSpecialization && typeMap.has(attr.baseName),
        )
      ) {
        imports.add("uniqueIndex")
      }
    }

    // Check if we need sql import (for audit column defaults, views, or user defaults/inits that use SQL)
    // Note: String/number/boolean defaults don't need sql, only systemdate and complex expressions do
    let needsSql = needsViews || program.types.length > 0
    if (!needsSql) {
      for (const type of program.types) {
        for (const attr of type.attributes) {
          const expr = attr.default ?? attr.init
          if (expr) {
            const result = generateDefaultExpression(expr)
            if (result?.useSql) {
              needsSql = true
              break
            }
          }
        }
        if (needsSql) break
      }
    }

    // Check if we have any self-references (need AnySQLiteColumn type)
    let hasSelfReferences = false
    for (const type of program.types) {
      for (const attr of type.attributes) {
        const referencedType = typeMap.get(attr.baseName)
        if (referencedType && referencedType.name === type.name) {
          hasSelfReferences = true
          imports.add("AnySQLiteColumn")
          break
        }
      }
      if (hasSelfReferences) break
    }

    // Check if we need relations import by generating relations early
    const relationDefs = generateRelations(program, typeMap)
    const needsRelations = relationDefs.length > 0

    // Generate the file
    const lines: string[] = []

    // Add imports
    if (needsSql) {
      lines.push('import { sql } from "drizzle-orm"')
    }
    if (needsRelations) {
      lines.push('import { relations } from "drizzle-orm/_relations"')
    }

    // Separate type imports from value imports
    const typeImports: string[] = []
    const valueImports: string[] = []

    for (const imp of Array.from(imports).sort()) {
      if (imp === "AnySQLiteColumn") {
        typeImports.push(imp)
      } else {
        valueImports.push(imp)
      }
    }

    if (typeImports.length > 0) {
      lines.push(
        `import type { ${typeImports.join(", ")} } from "drizzle-orm/sqlite-core"`,
      )
    }
    lines.push(
      `import { ${valueImports.join(", ")} } from "drizzle-orm/sqlite-core"`,
    )
    if (hasDateTimeColumns) {
      lines.push('import { DateTime } from "effect"')
    }
    lines.push('import { ulid } from "ulidx"')
    lines.push("")
    lines.push(`// Generated from Xplain DDL: ${sourceFile}`)
    lines.push("// Auto-generated - DO NOT EDIT")
    lines.push("")

    // Generate citext custom type if needed
    if (needsCitextColumn) {
      lines.push(
        "// Custom type for case-insensitive text columns (SQLite COLLATE NOCASE)",
      )
      lines.push("// Note: COLLATE NOCASE is ASCII-only case folding")
      lines.push(
        "const citextColumn = customType<{ data: string; driverData: string }>({",
      )
      lines.push("  dataType() {")
      lines.push('    return "text collate nocase"')
      lines.push("  },")
      lines.push("})")
      lines.push("")
    }

    // Generate non-null JSON column customType if needed
    if (needsJsonColumn) {
      lines.push("// Custom type for JSON columns")
      lines.push(
        "const jsonColumn = customType<{ data: Record<string, unknown> | unknown[]; driverData: string | null }>({",
      )
      lines.push("  dataType() {")
      lines.push('    return "text"')
      lines.push("  },")
      lines.push(
        "  toDriver(value: Record<string, unknown> | unknown[]): string {",
      )
      lines.push("    return JSON.stringify(value)")
      lines.push("  },")
      lines.push(
        "  fromDriver(value: string | null): Record<string, unknown> | unknown[] {",
      )
      lines.push("    return value == null ? {} : JSON.parse(value)")
      lines.push("  },")
      lines.push("})")
      lines.push("")
    }

    // Generate custom datetime type if needed
    if (hasDateTimeColumns) {
      lines.push("// Custom type for Effect DateTime columns")
      lines.push(
        "const effectDateTime = customType<{ data: DateTime.Utc; driverData: number }>({",
      )
      lines.push("  dataType() {")
      lines.push('    return "real"')
      lines.push("  },")
      lines.push("  toDriver(value: DateTime.Utc): number {")
      lines.push("    const millis = DateTime.toEpochMillis(value)")
      lines.push("    return millis / 86400000 + 2440587.5")
      lines.push("  },")
      lines.push(
        "  // Warning: value can be undefined when using findFirst and no row exists",
      )
      lines.push("  fromDriver(value: number): DateTime.Utc {")
      lines.push("    const millis = (value - 2440587.5) * 86400000")
      lines.push("    return DateTime.unsafeMake(millis)")
      lines.push("  },")
      lines.push("})")
      lines.push("")
    }

    // Generate tables
    for (const type of program.types) {
      const table = yield* generateTable(type, baseMap, typeMap, prefix)
      lines.push(table)
    }

    // Generate views for extends
    if (needsViews) {
      lines.push("// Views for virtual attributes")
      const extendViews = generateExtendViews(program, baseMap, typeMap, prefix)
      lines.push(...extendViews)
    }

    // Generate type exports
    lines.push("// Type exports")
    for (const type of program.types) {
      const typeExports = generateTypeExports(type)
      lines.push(...typeExports)
    }
    lines.push("")

    // Generate relations
    if (relationDefs.length > 0) {
      lines.push("// Relations")
      lines.push(...relationDefs)
    }

    return `${lines.join("\n")}\n`
  })
