import pluralize from "@theothergothamdev/pluralize-ts"
import type {
  AttributeNode,
  ExpressionNode,
  Program,
  TypeDeclaration,
} from "@pf/xplain-ddl"

/**
 * Length of ID columns: 26 chars for ULID + up to 15 chars for prefix with hyphen
 * Format: "prefix-01ARZ3NDEKTSV4RRFFQ69G5FAV" (e.g., "cust-01ARZ3...")
 */
export const ID_COLUMN_LENGTH = 41

/**
 * Convert an Xplain identifier to snake_case for database column names
 */
export const toSnakeCase = (str: string): string =>
  str.replace(/\s+/g, "_").toLowerCase()

/**
 * Generate a prefixed SQL table name
 * @param name - The Xplain type name (e.g., "org unit")
 * @param prefix - Optional prefix to prepend (e.g., "pf_")
 * @returns SQL table name (e.g., "pf_org_unit")
 */
export const toTableName = (name: string, prefix = ""): string =>
  `${prefix}${toSnakeCase(name)}`

/**
 * Generate a unique index name by prefixing with table name
 * @param tableName - The table name (e.g., "org unit")
 * @param indexName - The index name from DDL (e.g., "pathidx")
 * @param prefix - Optional prefix for the table portion of the index name
 * @returns Unique index name (e.g., "org_unit_pathidx_idx")
 */
export const generateIndexName = (
  tableName: string,
  indexName: string,
  prefix = "",
): string => `${toTableName(tableName, prefix)}_${toSnakeCase(indexName)}_idx`

/**
 * Generate SQL subquery for nil/any retrieval functions with proper JOINs for 'its' chains
 *
 * Used by both nil and any functions to generate the EXISTS subquery. The caller
 * determines whether to use "exists" (for any) or "not exists" (for nil).
 *
 * @param parentTableName - The parent table name (e.g., "process")
 * @param childTypeName - The child type name from the DDL (e.g., "process execution")
 * @param perPathSegments - Array of attribute names in the path (e.g., ["process state", "process"])
 * @param typeMap - Map of type names to type declarations
 * @param softDeleteFilter - SQL fragment for soft delete filter (e.g., "= false" for PostgreSQL, "= 0" for SQLite)
 * @param prefix - Optional prefix for SQL table names
 * @returns SQL subquery string with JOINs and WHERE clause
 *
 * @example
 * // For: nil process execution per process state its process
 * // Returns: select 1 from process_execution
 * //          join process_state on process_execution.process_state_id = process_state.id
 * //                            and process_state._deleted = false
 * //          where process_state.process_id = process.id
 * //          and process_execution._deleted = false
 */
export const generateExistsSubquery = (
  parentTableName: string,
  childTypeName: string,
  perPathSegments: string[],
  typeMap: Map<string, TypeDeclaration>,
  softDeleteFilter = "= false",
  prefix = "",
): string => {
  const childTableName = toTableName(childTypeName, prefix)
  const joins: string[] = []

  let currentTypeName = childTypeName
  let currentTableName = childTableName

  for (let i = 0; i < perPathSegments.length; i++) {
    const attrName = perPathSegments[i]
    const isLastSegment = i === perPathSegments.length - 1

    // Find the attribute in the current type with this name
    const currentType = typeMap.get(currentTypeName)
    if (!currentType) {
      continue
    }

    const attr = currentType.attributes.find((a) => a.name === attrName)
    if (!attr) {
      continue
    }

    // Determine the foreign key column name using same logic as generateColumn
    const foreignKeyColumn =
      attr.baseName === attr.name
        ? `${toSnakeCase(attr.name)}_id`
        : toSnakeCase(attr.name)

    if (!isLastSegment) {
      // Generate JOIN to the referenced table with soft delete filter
      const referencedTableName = toTableName(attr.baseName, prefix)
      joins.push(
        `join ${referencedTableName} on ${currentTableName}.${foreignKeyColumn} = ${referencedTableName}.id and ${referencedTableName}._deleted ${softDeleteFilter}`,
      )
      currentTypeName = attr.baseName
      currentTableName = referencedTableName
    } else {
      // Generate WHERE clause with soft delete filter on the child table
      const joinsStr =
        joins.length > 0 ? `\n    ${joins.join("\n    ")}\n    ` : " "
      return `select 1 from ${childTableName}${joinsStr}where ${currentTableName}.${foreignKeyColumn} = ${parentTableName}.id and ${childTableName}._deleted ${softDeleteFilter}`
    }
  }

  // Fallback if perPath is empty (should not happen with valid DDL)
  return `select 1 from ${childTableName} where false`
}

/**
 * Generate SQL scalar subquery for 'some' retrieval function
 *
 * Similar to generateExistsSubquery but selects a specific column instead of "1".
 * Used by the 'some' function to return the first matching value from the related table.
 *
 * @param parentTableName - The parent table name (e.g., "process")
 * @param childTypeName - The child type name from the DDL (e.g., "process execution")
 * @param columnToSelect - The column to select from the child table (e.g., "score" or "product.price")
 * @param perPathSegments - Array of attribute names in the path (e.g., ["process state", "process"])
 * @param typeMap - Map of type names to type declarations
 * @param softDeleteFilter - SQL fragment for soft delete filter (e.g., "= false" for PostgreSQL, "= 0" for SQLite)
 * @param prefix - Optional prefix for SQL table names
 * @returns SQL scalar subquery string with JOINs, WHERE clause, and LIMIT 1
 *
 * @example
 * // For: some child its score per parent
 * // Returns: select score from child where child.parent_id = parent.id and child._deleted = false limit 1
 *
 * @example
 * // For: some invoice_line its product its price per invoice
 * // Returns: select product.price from invoice_line
 * //          join product on invoice_line.product_id = product.id and product._deleted = false
 * //          where invoice_line.invoice_id = invoice.id and invoice_line._deleted = false limit 1
 */
export const generateScalarSubquery = (
  parentTableName: string,
  childTypeName: string,
  columnToSelect: string,
  perPathSegments: string[],
  typeMap: Map<string, TypeDeclaration>,
  softDeleteFilter = "= false",
  prefix = "",
): string => {
  const childTableName = toTableName(childTypeName, prefix)
  const joins: string[] = []

  let currentTypeName = childTypeName
  let currentTableName = childTableName

  for (let i = 0; i < perPathSegments.length; i++) {
    const attrName = perPathSegments[i]
    const isLastSegment = i === perPathSegments.length - 1

    // Find the attribute in the current type with this name
    const currentType = typeMap.get(currentTypeName)
    if (!currentType) {
      continue
    }

    const attr = currentType.attributes.find((a) => a.name === attrName)
    if (!attr) {
      continue
    }

    // Determine the foreign key column name using same logic as generateColumn
    const foreignKeyColumn =
      attr.baseName === attr.name
        ? `${toSnakeCase(attr.name)}_id`
        : toSnakeCase(attr.name)

    if (!isLastSegment) {
      // Generate JOIN to the referenced table with soft delete filter
      const referencedTableName = toTableName(attr.baseName, prefix)
      joins.push(
        `join ${referencedTableName} on ${currentTableName}.${foreignKeyColumn} = ${referencedTableName}.id and ${referencedTableName}._deleted ${softDeleteFilter}`,
      )
      currentTypeName = attr.baseName
      currentTableName = referencedTableName
    } else {
      // Generate WHERE clause with soft delete filter on the child table
      const joinsStr =
        joins.length > 0 ? `\n    ${joins.join("\n    ")}\n    ` : " "
      return `select ${columnToSelect} from ${childTableName}${joinsStr}where ${currentTableName}.${foreignKeyColumn} = ${parentTableName}.id and ${childTableName}._deleted ${softDeleteFilter} limit 1`
    }
  }

  // Fallback if perPath is empty (should not happen with valid DDL)
  return `select ${columnToSelect} from ${childTableName} where false limit 1`
}

/**
 * Options for generating scalar subqueries with where predicates
 */
interface ScalarSubqueryWithWhereOptions {
  parentTableName: string
  childTypeName: string
  columnToSelect: string
  perPathSegments: string[]
  typeMap: Map<string, TypeDeclaration>
  wherePredicateName: string // Name of the virtual attribute to filter by (e.g., "can start process")
  booleanTrueValue?: string // How to represent true in SQL: "1" for SQLite, "true" for PostgreSQL
  softDeleteFilter?: string // SQL fragment for soft delete filter (e.g., "= false" for PostgreSQL, "= 0" for SQLite)
  prefix?: string // Optional prefix for SQL table names
}

/**
 * Generate SQL scalar subquery for 'some' retrieval function with a where predicate
 *
 * This version joins with the virtual attribute view to filter by a computed predicate.
 * Used when the 'some' function has a 'where' clause that references a virtual attribute.
 *
 * @param options - Configuration for generating the subquery
 * @returns SQL scalar subquery string with JOINs, WHERE clause (including predicate filter), and LIMIT 1
 *
 * @example
 * // For: some step where can start process per process
 * // Returns: select step.id from step
 * //          join step_its_can_start_process on step.id = step_its_can_start_process.id
 * //          where step.process_id = process.id
 * //          and step_its_can_start_process.can_start_process = 1
 * //          and step._deleted = false
 * //          limit 1
 */
export const generateScalarSubqueryWithWhere = (
  options: ScalarSubqueryWithWhereOptions,
): string => {
  const {
    parentTableName,
    childTypeName,
    columnToSelect,
    perPathSegments,
    typeMap,
    wherePredicateName,
    booleanTrueValue = "1", // Default to SQLite-style
    softDeleteFilter = "= false", // Default to PostgreSQL-style
    prefix = "",
  } = options

  const childTableName = toTableName(childTypeName, prefix)
  const joins: string[] = []

  // Add join for the virtual attribute view
  const viewTableName = `${childTableName}_its_${toSnakeCase(wherePredicateName)}`
  const predicateColumn = toSnakeCase(wherePredicateName)
  joins.push(
    `join ${viewTableName} on ${childTableName}.id = ${viewTableName}.id`,
  )

  let currentTypeName = childTypeName
  let currentTableName = childTableName

  for (let i = 0; i < perPathSegments.length; i++) {
    const attrName = perPathSegments[i]
    const isLastSegment = i === perPathSegments.length - 1

    // Find the attribute in the current type with this name
    const currentType = typeMap.get(currentTypeName)
    if (!currentType) {
      continue
    }

    const attr = currentType.attributes.find((a) => a.name === attrName)
    if (!attr) {
      continue
    }

    // Determine the foreign key column name using same logic as generateColumn
    const foreignKeyColumn =
      attr.baseName === attr.name
        ? `${toSnakeCase(attr.name)}_id`
        : toSnakeCase(attr.name)

    if (!isLastSegment) {
      // Generate JOIN to the referenced table with soft delete filter
      const referencedTableName = toTableName(attr.baseName, prefix)
      joins.push(
        `join ${referencedTableName} on ${currentTableName}.${foreignKeyColumn} = ${referencedTableName}.id and ${referencedTableName}._deleted ${softDeleteFilter}`,
      )
      currentTypeName = attr.baseName
      currentTableName = referencedTableName
    } else {
      // Generate WHERE clause with soft delete filter on the child table
      const joinsStr = `\n    ${joins.join("\n    ")}\n    `
      const whereClause = `where ${currentTableName}.${foreignKeyColumn} = ${parentTableName}.id\n    and ${viewTableName}.${predicateColumn} = ${booleanTrueValue}\n    and ${childTableName}._deleted ${softDeleteFilter}`
      return `select ${columnToSelect} from ${childTableName}${joinsStr}${whereClause}\n    limit 1`
    }
  }

  // Fallback if perPath is empty (should not happen with valid DDL)
  return `select ${columnToSelect} from ${childTableName} where false limit 1`
}

/**
 * Build LEFT OUTER JOIN clauses for aggregate view queries.
 *
 * Walks the perPath from child to parent, collecting join information,
 * then builds the JOINs in reverse order (from parent outward to child).
 *
 * @param childTypeName - The child type name from the DDL
 * @param perPathSegments - Array of attribute names in the path
 * @param typeMap - Map of type names to type declarations
 * @param softDeleteFilter - SQL fragment for soft delete filter (e.g., "= false" for PostgreSQL, "= 0" for SQLite)
 * @param prefix - Optional prefix for SQL table names
 * @returns Array of LEFT OUTER JOIN clause strings
 */
const buildAggregateJoins = (
  childTypeName: string,
  perPathSegments: string[],
  typeMap: Map<string, TypeDeclaration>,
  softDeleteFilter = "= false",
  prefix = "",
): string[] => {
  const childTableName = toTableName(childTypeName, prefix)
  const joinInfo: Array<{
    fromTable: string
    toTable: string
    fromColumn: string
    toColumn: string
  }> = []

  let currentTypeName = childTypeName
  let previousTableName = childTableName

  for (let i = 0; i < perPathSegments.length; i++) {
    const attrName = perPathSegments[i]

    const currentType = typeMap.get(currentTypeName)
    if (!currentType) continue

    const attr = currentType.attributes.find((a) => a.name === attrName)
    if (!attr) continue

    const foreignKeyColumn =
      attr.baseName === attr.name
        ? `${toSnakeCase(attr.name)}_id`
        : toSnakeCase(attr.name)

    const referencedTableName = toTableName(attr.baseName, prefix)

    joinInfo.push({
      fromTable: referencedTableName,
      toTable: previousTableName,
      fromColumn: "id",
      toColumn: foreignKeyColumn,
    })

    currentTypeName = attr.baseName
    previousTableName = referencedTableName
  }

  // Build JOINs in reverse order (from parent outward to child)
  // Include soft delete filter on each joined table
  const joins: string[] = []
  for (let i = joinInfo.length - 1; i >= 0; i--) {
    const info = joinInfo[i]
    if (info) {
      joins.push(
        `left outer join ${info.toTable} on ${info.toTable}.${info.toColumn} = ${info.fromTable}.${info.fromColumn} and ${info.toTable}._deleted ${softDeleteFilter}`,
      )
    }
  }

  return joins
}

/**
 * Generate SQL view body for 'count' retrieval function using JOINs and GROUP BY
 *
 * Uses LEFT OUTER JOINs from the parent table through the relationship chain to the child,
 * then COUNT(DISTINCT) with GROUP BY for optimal performance. This avoids correlated
 * subqueries which would execute once per parent row.
 *
 * @param parentTableName - The parent table name (e.g., "process")
 * @param childTypeName - The child type name from the DDL (e.g., "todo")
 * @param perPathSegments - Array of attribute names in the path (e.g., ["process execution", "process"])
 * @param typeMap - Map of type names to type declarations
 * @param virtualAttrName - The snake_case name of the virtual attribute
 * @param softDeleteFilter - SQL fragment for soft delete filter (e.g., "= false" for PostgreSQL, "= 0" for SQLite)
 * @param prefix - Optional prefix for SQL table names
 * @returns SQL view body with SELECT, FROM, LEFT OUTER JOINs, and GROUP BY
 *
 * @example
 * // For: count todo per process execution its process
 * // Returns:
 * //   select process.id, count(distinct todo.process_execution_id) as active_count
 * //   from process
 * //   left outer join process_execution on process_execution.process_id = process.id and process_execution._deleted = false
 * //   left outer join todo on todo.process_execution_id = process_execution.id and todo._deleted = false
 * //   group by process.id
 */
export const generateCountViewBody = (
  parentTableName: string,
  childTypeName: string,
  perPathSegments: string[],
  typeMap: Map<string, TypeDeclaration>,
  virtualAttrName: string,
  softDeleteFilter = "= false",
  prefix = "",
): string => {
  const childTableName = toTableName(childTypeName, prefix)
  const joins = buildAggregateJoins(
    childTypeName,
    perPathSegments,
    typeMap,
    softDeleteFilter,
    prefix,
  )

  // Count distinct child IDs (the actual child records being counted)
  const countColumn = `${childTableName}.id`

  const joinsStr = joins.length > 0 ? `\n  ${joins.join("\n  ")}\n  ` : "\n  "

  return `select
    ${parentTableName}.id,
    count(distinct ${countColumn}) as ${virtualAttrName}
  from ${parentTableName}${joinsStr}group by
    ${parentTableName}.id`
}

/**
 * Generate SQL view body for 'total', 'min', 'max' retrieval functions using JOINs and GROUP BY
 *
 * Uses LEFT OUTER JOINs from the parent table through the relationship chain to the child,
 * then applies the aggregate function (SUM/MIN/MAX) with GROUP BY for optimal performance.
 *
 * @param parentTableName - The parent table name (e.g., "invoice")
 * @param childTypeName - The child type name from the DDL (e.g., "invoice line")
 * @param perPathSegments - Array of attribute names in the path (e.g., ["invoice"])
 * @param typeMap - Map of type names to type declarations
 * @param virtualAttrName - The snake_case name of the virtual attribute
 * @param aggregateColumn - The column to aggregate (e.g., "invoice_line.amount")
 * @param aggregateFunction - The SQL aggregate function: "sum", "min", or "max"
 * @param softDeleteFilter - SQL fragment for soft delete filter (e.g., "= false" for PostgreSQL, "= 0" for SQLite)
 * @param prefix - Optional prefix for SQL table names
 * @returns SQL view body with SELECT, FROM, LEFT OUTER JOINs, and GROUP BY
 *
 * @example
 * // For: total invoice line its amount per invoice
 * // Returns:
 * //   select invoice.id, sum(invoice_line.amount) as invoice_total
 * //   from invoice
 * //   left outer join invoice_line on invoice_line.invoice_id = invoice.id and invoice_line._deleted = false
 * //   group by invoice.id
 */
export const generateAggregateViewBody = (
  parentTableName: string,
  childTypeName: string,
  perPathSegments: string[],
  typeMap: Map<string, TypeDeclaration>,
  virtualAttrName: string,
  aggregateColumn: string,
  aggregateFunction: "sum" | "min" | "max",
  softDeleteFilter = "= false",
  prefix = "",
): string => {
  const joins = buildAggregateJoins(
    childTypeName,
    perPathSegments,
    typeMap,
    softDeleteFilter,
    prefix,
  )
  const joinsStr = joins.length > 0 ? `\n  ${joins.join("\n  ")}\n  ` : "\n  "

  return `select
    ${parentTableName}.id,
    ${aggregateFunction}(${aggregateColumn}) as ${virtualAttrName}
  from ${parentTableName}${joinsStr}group by
    ${parentTableName}.id`
}

/**
 * Convert an Xplain identifier to camelCase for TypeScript identifiers
 */
export const toCamelCase = (str: string): string => {
  const snakeCase = toSnakeCase(str)
  return snakeCase.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
}

const getTableColumnReference = (
  attrName: string,
  type: TypeDeclaration,
  typeMap: Map<string, TypeDeclaration>,
): string => {
  const attr = type.attributes.find((attribute) => attribute.name === attrName)
  if (!attr) {
    throw new Error(
      `Unknown CHECK constraint attribute '${attrName}' on type '${type.name}'`,
    )
  }

  const referencedType = typeMap.get(attr.baseName)
  const columnPropertyName = referencedType
    ? `${toCamelCase(attr.name)}Id`
    : toCamelCase(attr.name)

  return `\${table.${columnPropertyName}}`
}

const isNilLiteral = (expr: ExpressionNode): boolean =>
  expr.kind === "literal" && expr.valueType === "nil"

const escapeSqlTemplateLiteralText = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${")

const assertNever = (value: never): never => {
  throw new Error(`Unsupported CHECK literal type: ${String(value)}`)
}

const generateCheckLiteralSql = (
  expr: Extract<ExpressionNode, { kind: "literal" }>,
): string => {
  switch (expr.valueType) {
    case "nil":
      return "null"
    case "boolean":
      return String(expr.value)
    case "number":
      return String(expr.value)
    case "string":
      return `'${escapeSqlTemplateLiteralText(String(expr.value).replaceAll("'", "''"))}'`
    case "systemdate":
      return "current_timestamp"
    default:
      return assertNever(expr.valueType)
  }
}

/**
 * Generate a Drizzle sql template body for a same-row CHECK constraint.
 */
export const generateCheckConstraintSql = (
  expr: ExpressionNode,
  type: TypeDeclaration,
  typeMap: Map<string, TypeDeclaration>,
): string => {
  switch (expr.kind) {
    case "literal":
      return generateCheckLiteralSql(expr)

    case "identifier":
      return getTableColumnReference(expr.name, type, typeMap)

    case "binary_op": {
      if (expr.operator === "==" && isNilLiteral(expr.right)) {
        return `${generateCheckConstraintSql(expr.left, type, typeMap)} is null`
      }
      if (expr.operator === "==" && isNilLiteral(expr.left)) {
        return `${generateCheckConstraintSql(expr.right, type, typeMap)} is null`
      }
      if (expr.operator === "!=" && isNilLiteral(expr.right)) {
        return `${generateCheckConstraintSql(expr.left, type, typeMap)} is not null`
      }
      if (expr.operator === "!=" && isNilLiteral(expr.left)) {
        return `${generateCheckConstraintSql(expr.right, type, typeMap)} is not null`
      }

      const left = generateCheckConstraintSql(expr.left, type, typeMap)
      const right = generateCheckConstraintSql(expr.right, type, typeMap)
      const operator = expr.operator === "==" ? "=" : expr.operator
      return `${left} ${operator} ${right}`
    }

    case "conditional":
    case "path":
    case "retrieval_function":
      throw new Error(`Unsupported CHECK constraint expression: ${expr.kind}`)
  }
}

/**
 * Generate type exports for a table
 */
export const generateTypeExports = (type: TypeDeclaration): string[] => {
  const constName = toCamelCase(type.name)
  const typeName = constName.charAt(0).toUpperCase() + constName.slice(1)

  return [
    `export type ${typeName} = typeof ${constName}.$inferSelect`,
    `export type New${typeName} = typeof ${constName}.$inferInsert`,
  ]
}

/**
 * Generate relations for all tables
 */
export const generateRelations = (
  program: Program,
  typeMap: Map<string, TypeDeclaration>,
): string[] => {
  const relationDefs: string[] = []
  const edgeName = (
    type: TypeDeclaration,
    attr: AttributeNode,
  ): string | undefined =>
    type.attributes.some(
      (other) => other !== attr && other.baseName === attr.baseName,
    )
      ? `${toCamelCase(type.name)}_${toCamelCase(attr.name)}`
      : undefined

  for (const type of program.types) {
    const constName = toCamelCase(type.name)
    const relations: string[] = []

    // Find "one" relations (foreign keys in this table)
    const selfReferenceAttrs: AttributeNode[] = []
    for (const attr of type.attributes) {
      const referencedType = typeMap.get(attr.baseName)
      if (referencedType) {
        const relationName = toCamelCase(attr.name)
        const referencedConstName = toCamelCase(referencedType.name)
        const name = edgeName(type, attr)
        relations.push(
          `  ${relationName}: one(${referencedConstName}, {\n` +
            (name ? `    relationName: "${name}",\n` : "") +
            `    fields: [${constName}.${relationName}Id],\n` +
            `    references: [${referencedConstName}.id],\n` +
            "  }),",
        )

        // Track self-references for adding "many" relation later
        if (referencedType.name === type.name) {
          selfReferenceAttrs.push(attr)
        }
      }
    }

    // Find "many" or "one" relations (foreign keys in other tables pointing to this table)
    const manyRelations = new Set<string>()
    const oneRelations = new Set<string>()

    for (const otherType of program.types) {
      if (otherType.name === type.name) continue

      for (const attr of otherType.attributes) {
        if (attr.baseName === type.name) {
          const otherConstName = toCamelCase(otherType.name)
          const name = edgeName(otherType, attr)

          if (attr.isSpecialization) {
            // Specialization: parent has "one" relation to child
            const relationName = otherConstName // singular
            if (!oneRelations.has(relationName)) {
              oneRelations.add(relationName)
              relations.push(
                `  ${relationName}: one(${otherConstName}, {\n` +
                  (name ? `    relationName: "${name}",\n` : "") +
                  `    fields: [${constName}.id],\n` +
                  `    references: [${otherConstName}.${toCamelCase(attr.name)}Id],\n` +
                  "  }),",
              )
            }
          } else {
            // Regular attribute: parent has "many" relation to children
            const relationName = pluralize.plural(otherConstName)
            if (!manyRelations.has(relationName)) {
              manyRelations.add(relationName)
              // Preserve the existing inverse's first foreign-key edge.
              relations.push(
                `  ${relationName}: many(${otherConstName}${name ? `, { relationName: "${name}" }` : ""}),`,
              )
            }
          }
        }
      }
    }

    // Add "many" relations for self-references (children)
    if (selfReferenceAttrs.length > 0) {
      const relationName = "children"
      // Only add if we haven't seen this relation name yet
      if (!manyRelations.has(relationName)) {
        manyRelations.add(relationName)
        const firstAttr = selfReferenceAttrs[0]
        const name = firstAttr ? edgeName(type, firstAttr) : undefined
        relations.push(
          `  ${relationName}: many(${constName}${name ? `, { relationName: "${name}" }` : ""}),`,
        )
      }
    }

    // Only generate relations if there are any
    if (relations.length > 0) {
      const hasOne = relations.some((r) => r.includes("one("))
      const hasMany = relations.some((r) => r.includes("many("))

      let helperParams = "({ "
      if (hasOne && hasMany) {
        helperParams += "one, many "
      } else if (hasOne) {
        helperParams += "one "
      } else {
        helperParams += "many "
      }
      helperParams += "})"

      relationDefs.push(
        `\nexport const ${constName}Relations = relations(${constName}, ${helperParams} => ({`,
        ...relations,
        "}))",
      )
    }
  }

  return relationDefs
}
