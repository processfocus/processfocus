// biome-ignore-all lint/suspicious/noExplicitAny: legacy code
import type {
  AssertConstraintNode,
  AssertNode,
  AssertRange,
  AttributeNode,
  BaseDeclaration,
  Cardinality,
  DataType,
  ExpressionNode,
  ExtendNode,
  IndexNode,
  PathNode,
  Program,
  RetrievalFunctionNode,
  TypeDeclaration,
} from "./ast.js"
import { parser } from "./parser.js"

const BaseCstVisitor = parser.getBaseCstVisitorConstructor()

export class XplainVisitor extends BaseCstVisitor {
  constructor() {
    super()
    this.validateVisitor()
  }

  program(ctx: any): Program {
    const bases: BaseDeclaration[] = []
    const types: TypeDeclaration[] = []
    const defaults: Array<{
      typeName: string
      attributeName: string
      expression: ExpressionNode
    }> = []
    const inits: Array<{
      typeName: string
      attributeName: string
      expression: ExpressionNode
    }> = []
    const extendsList: Array<{ typeName: string; extend: ExtendNode }> = []
    const indexes: Array<{ typeName: string; index: IndexNode }> = []
    const asserts: Array<{ typeName: string; assert: AssertConstraintNode }> =
      []

    if (ctx.statement) {
      for (const stmtCtx of ctx.statement) {
        const result = this.visit(stmtCtx)
        if (result.kind === "base") {
          bases.push(result)
        } else if (result.kind === "type") {
          types.push(result)
        } else if (result.kind === "assert") {
          if (result.assertKind === "constraint") {
            asserts.push({
              typeName: result.typeName,
              assert: {
                name: result.attributeName,
                expression: result.expression,
                line: result.line,
                column: result.column,
              },
            })
          } else {
            // Treat cardinality asserts like extends - add to extendsList
            extendsList.push({
              typeName: result.typeName,
              extend: {
                attributeName: result.attributeName,
                expression: result.expression,
                cardinality: result.cardinality,
                line: result.line,
                column: result.column,
              },
            })
          }
        } else if (result.kind === "default") {
          defaults.push(result)
        } else if (result.kind === "init") {
          inits.push(result)
        } else if (result.kind === "extend") {
          extendsList.push(result)
        } else if (result.kind === "index") {
          indexes.push(result)
        }
      }
    }

    // Post-process: attach defaults, inits, and indexes to types
    const typeMap = new Map<string, TypeDeclaration>()
    for (const type of types) {
      typeMap.set(type.name, type)
    }

    // Attach defaults
    for (const def of defaults) {
      const type = typeMap.get(def.typeName)
      if (type) {
        const attr = type.attributes.find(
          (a: AttributeNode) => a.name === def.attributeName,
        )
        if (attr) {
          attr.default = def.expression
        }
      }
    }

    // Attach inits
    for (const init of inits) {
      const type = typeMap.get(init.typeName)
      if (type) {
        const attr = type.attributes.find(
          (a: AttributeNode) => a.name === init.attributeName,
        )
        if (attr) {
          attr.init = init.expression
        }
      }
    }

    // Attach extends (track orphaned ones for error reporting)
    const orphanedExtends: Array<{ typeName: string; extend: ExtendNode }> = []
    for (const ext of extendsList) {
      const type = typeMap.get(ext.typeName)
      if (type) {
        type.extends.push(ext.extend)
      } else {
        orphanedExtends.push(ext)
      }
    }

    // Attach static assert constraints (track orphaned ones for error reporting)
    const orphanedAsserts: Array<{
      typeName: string
      assert: AssertConstraintNode
    }> = []
    for (const assertion of asserts) {
      const type = typeMap.get(assertion.typeName)
      if (type) {
        type.asserts.push(assertion.assert)
      } else {
        orphanedAsserts.push(assertion)
      }
    }

    // Attach indexes (track orphaned ones for error reporting)
    const orphanedIndexes: Array<{ typeName: string; index: IndexNode }> = []
    for (const idx of indexes) {
      const type = typeMap.get(idx.typeName)
      if (type) {
        if (idx.index.unique) {
          type.uniqueIndexes.push(idx.index)
        } else {
          type.indexes.push(idx.index)
        }
      } else {
        orphanedIndexes.push(idx)
      }
    }

    // Store orphaned extends and indexes in properties we can check during validation
    // For now, we'll just track them in the program metadata
    const program: Program = { bases, types }
    if (orphanedExtends.length > 0) {
      program._orphanedExtends = orphanedExtends
    }
    if (orphanedIndexes.length > 0) {
      program._orphanedIndexes = orphanedIndexes
    }
    if (orphanedAsserts.length > 0) {
      program._orphanedAsserts = orphanedAsserts
    }

    return program
  }

  statement(
    ctx: any,
  ): BaseDeclaration | TypeDeclaration | AssertNode | { kind: "other" } {
    if (ctx.baseDeclaration) {
      return this.visit(ctx.baseDeclaration)
    } else if (ctx.typeDeclaration) {
      return this.visit(ctx.typeDeclaration)
    } else if (ctx.indexDeclaration) {
      return this.visit(ctx.indexDeclaration)
    } else if (ctx.defaultDeclaration) {
      return this.visit(ctx.defaultDeclaration)
    } else if (ctx.initDeclaration) {
      return this.visit(ctx.initDeclaration)
    } else if (ctx.assertDeclaration) {
      return this.visit(ctx.assertDeclaration)
    } else if (ctx.extendDeclaration) {
      return this.visit(ctx.extendDeclaration)
    }
    return { kind: "other" }
  }

  baseDeclaration(ctx: any): BaseDeclaration {
    const name = this.visit(ctx.simpleIdentifier)
    const dataType = this.visit(ctx.dataType)
    const token = ctx.Base?.[0]
    return {
      kind: "base",
      name,
      dataType,
      line: token?.startLine,
      column: token?.startColumn,
    }
  }

  dataType(ctx: any): DataType {
    if (ctx.DataTypeA) {
      const maxLength = parseInt(ctx.NumberLiteral[0].image, 10)
      return { type: "text", maxLength }
    } else if (ctx.DataTypeB) {
      return { type: "boolean" }
    } else if (ctx.DataTypeC) {
      const maxLength = parseInt(ctx.NumberLiteral[0].image, 10)
      return { type: "citext", maxLength }
    } else if (ctx.DataTypeD) {
      return { type: "datetime" }
    } else if (ctx.DataTypeI) {
      const maxDigits = parseInt(ctx.NumberLiteral[0].image, 10)
      return { type: "integer", maxDigits }
    } else if (ctx.DataTypeJ) {
      return { type: "json" }
    } else if (ctx.DataTypeR) {
      const digitsBefore = parseInt(ctx.NumberLiteral[0].image, 10)
      const digitsAfter = parseInt(ctx.NumberLiteral[1].image, 10)
      return { type: "real", digitsBefore, digitsAfter }
    } else if (ctx.DataTypeT) {
      return { type: "unlimited_text" }
    } else if (ctx.DataTypeU) {
      return { type: "urn" }
    }
    throw new Error("Unknown data type")
  }

  typeDeclaration(ctx: any): TypeDeclaration {
    const name = this.visit(ctx.simpleIdentifier)
    const idPrefix = ctx.StringLiteral?.[0]?.image.slice(1, -1) // Remove quotes
    const attributes = this.visit(ctx.attributeList)
    const token = ctx.Type?.[0]
    return {
      kind: "type",
      name,
      ...(idPrefix !== undefined && { idPrefix }),
      attributes,
      extends: [],
      asserts: [],
      indexes: [],
      uniqueIndexes: [],
      line: token?.startLine,
      column: token?.startColumn,
    }
  }

  attributeList(ctx: any): AttributeNode[] {
    const attributes: AttributeNode[] = []
    for (const attrCtx of ctx.attributeRef) {
      attributes.push(this.visit(attrCtx))
    }
    return attributes
  }

  indexAttributeList(ctx: any): AttributeNode[] {
    const attributes: AttributeNode[] = []
    for (const attrCtx of ctx.indexAttributeRef) {
      attributes.push(this.visit(attrCtx))
    }
    return attributes
  }

  attributeRef(ctx: any): AttributeNode {
    const optional = !!ctx.Optional
    const isSpecialization = !!ctx.LBracket
    const name = this.visit(ctx.identifier)
    // Initialize baseName to name; transformer will resolve underscore prefixes
    const baseName = name
    const token = ctx.Identifier?.[0] || ctx.MultiWordIdentifier?.[0]
    return {
      name,
      baseName,
      optional,
      isSpecialization,
      line: token?.startLine,
      column: token?.startColumn,
    }
  }

  indexAttributeRef(ctx: any): AttributeNode {
    const optional = !!ctx.Optional
    // Indexes don't support specialization syntax
    const isSpecialization = false
    const name = this.visit(ctx.identifier)
    // Initialize baseName to name; transformer will resolve underscore prefixes
    const baseName = name
    const token = ctx.Identifier?.[0] || ctx.MultiWordIdentifier?.[0]
    return {
      name,
      baseName,
      optional,
      isSpecialization,
      line: token?.startLine,
      column: token?.startColumn,
    }
  }

  indexDeclaration(ctx: any): {
    kind: "index"
    typeName: string
    index: IndexNode
  } {
    const unique = !!ctx.Unique
    const typeName = this.visit(ctx.typeName)
    const indexName = this.visit(ctx.identifier)
    const attributes = this.visit(ctx.indexAttributeList).map(
      (attr: AttributeNode) => attr.name,
    )
    const token = ctx.Index?.[0]
    return {
      kind: "index",
      typeName,
      index: {
        name: indexName,
        attributes,
        unique,
        line: token?.startLine,
        column: token?.startColumn,
      },
    }
  }

  defaultDeclaration(ctx: any): {
    kind: "default"
    typeName: string
    attributeName: string
    expression: ExpressionNode
  } {
    const typeName = this.visit(ctx.typeName)
    const attributeName = this.visit(ctx.simpleAttributeName)
    const expression = this.visit(ctx.expression)
    return {
      kind: "default",
      typeName,
      attributeName,
      expression,
    }
  }

  initDeclaration(ctx: any): {
    kind: "init"
    typeName: string
    attributeName: string
    expression: ExpressionNode
  } {
    const typeName = this.visit(ctx.typeName)
    const attributeName = this.visit(ctx.simpleAttributeName)
    const expression = this.visit(ctx.expression)
    return {
      kind: "init",
      typeName,
      attributeName,
      expression,
    }
  }

  assertDeclaration(ctx: any): AssertNode {
    const typeName = this.visit(ctx.typeName)
    const attributeName = this.visit(ctx.simpleAttributeName)
    const assertRange = this.visit(ctx.assertRange)
    const expression = this.visit(ctx.expression)
    const token = ctx.Assert?.[0]

    if ("kind" in assertRange && assertRange.kind === "boolean") {
      return {
        kind: "assert",
        assertKind: "constraint",
        typeName,
        attributeName,
        expression,
        line: token?.startLine,
        column: token?.startColumn,
      }
    }

    return {
      kind: "assert",
      assertKind: "virtual",
      typeName,
      attributeName,
      cardinality: assertRange,
      expression,
      line: token?.startLine,
      column: token?.startColumn,
    }
  }

  extendDeclaration(ctx: any): {
    kind: "extend"
    typeName: string
    extend: ExtendNode
  } {
    const typeName = this.visit(ctx.typeName)
    const attributeName = this.visit(ctx.simpleAttributeName)
    const expression = this.visit(ctx.expression)
    const token = ctx.Extend?.[0]
    return {
      kind: "extend",
      typeName,
      extend: {
        attributeName,
        expression,
        line: token?.startLine,
        column: token?.startColumn,
      },
    }
  }

  cardinality(ctx: any): Cardinality {
    const min = parseInt(ctx.NumberLiteral[0].image, 10)
    let max: number | "unbounded"
    if (ctx.Star) {
      max = "unbounded"
    } else {
      max = parseInt(ctx.NumberLiteral[1].image, 10)
    }
    return { min, max }
  }

  assertRange(ctx: any): AssertRange {
    if (ctx.cardinality) {
      return this.visit(ctx.cardinality)
    }
    return { kind: "boolean", value: true }
  }

  expression(ctx: any): ExpressionNode {
    return this.visit(ctx.retrievalExpression)
  }

  retrievalExpression(ctx: any): ExpressionNode {
    // Check if this is a set expression per property (first alternative)
    if (ctx.setExpressionPerProperty) {
      return this.visit(ctx.setExpressionPerProperty)
    }

    // Otherwise, it's just a regular conditional expression
    return this.visit(ctx.conditionalExpression)
  }

  setExpressionPerProperty(ctx: any): ExpressionNode {
    const funcName = this.visit(ctx.setExpression)
    const perPath = this.visit(ctx.perPath)

    return {
      ...funcName,
      perPath,
    }
  }

  setExpression(ctx: any): Omit<RetrievalFunctionNode, "perPath"> {
    const funcName = this.visit(ctx.retrievalFunction)
    const typeName = this.visit(ctx.typeName)

    // Determine expression and wherePredicate based on which tokens are present
    // Grammar: function type [its expression] [where predicate]
    const hasIts = !!ctx.Its
    const hasWhere = !!ctx.Where
    const conditionalExpressions = ctx.conditionalExpression || []

    let expression: ReturnType<typeof this.visit> | undefined
    let wherePredicate: ReturnType<typeof this.visit> | undefined

    if (hasIts && hasWhere) {
      // Both present: first is expression, second is wherePredicate
      expression = conditionalExpressions[0]
        ? this.visit(conditionalExpressions[0])
        : undefined
      wherePredicate = conditionalExpressions[1]
        ? this.visit(conditionalExpressions[1])
        : undefined
    } else if (hasIts) {
      // Only its: expression only
      expression = conditionalExpressions[0]
        ? this.visit(conditionalExpressions[0])
        : undefined
    } else if (hasWhere) {
      // Only where: wherePredicate only
      wherePredicate = conditionalExpressions[0]
        ? this.visit(conditionalExpressions[0])
        : undefined
    }

    return {
      kind: "retrieval_function",
      function: funcName,
      typeName,
      expression,
      wherePredicate,
    }
  }

  retrievalFunction(
    ctx: any,
  ): "count" | "max" | "min" | "total" | "nil" | "any" | "some" {
    if (ctx.Count) return "count"
    if (ctx.Max) return "max"
    if (ctx.Min) return "min"
    if (ctx.Total) return "total"
    if (ctx.Nil) return "nil"
    if (ctx.Any) return "any"
    if (ctx.Some) return "some"
    throw new Error("Unknown retrieval function")
  }

  perPath(ctx: any): PathNode {
    const segments: string[] = []
    // perPath now uses attributeName chain
    if (ctx.attributeName && ctx.attributeName.length > 0) {
      for (const attrCtx of ctx.attributeName) {
        segments.push(this.visit(attrCtx))
      }
    }
    return {
      kind: "path",
      segments,
    }
  }

  conditionalExpression(ctx: any): ExpressionNode {
    if (ctx.If) {
      const condition = this.visit(ctx.logicalOrExpression[0])
      const thenExpr = this.visit(ctx.logicalOrExpression[1])
      const elseExpr = this.visit(ctx.logicalOrExpression[2])
      return {
        kind: "conditional",
        condition,
        thenExpr,
        elseExpr,
      }
    }
    return this.visit(ctx.logicalOrExpression[0])
  }

  logicalOrExpression(ctx: any): ExpressionNode {
    let result = this.visit(ctx.comparisonExpression[0])
    for (let i = 1; i < ctx.comparisonExpression.length; i++) {
      result = {
        kind: "binary_op",
        operator: "or",
        left: result,
        right: this.visit(ctx.comparisonExpression[i]),
      }
    }
    return result
  }

  comparisonExpression(ctx: any): ExpressionNode {
    const left = this.visit(ctx.additiveExpression[0])
    if (ctx.additiveExpression.length === 2) {
      const right = this.visit(ctx.additiveExpression[1])
      let operator: any
      if (ctx.GreaterThanEqual) operator = ">="
      else if (ctx.LessThanEqual) operator = "<="
      else if (ctx.GreaterThan) operator = ">"
      else if (ctx.LessThan) operator = "<"
      else if (ctx.EqualEqual) operator = "=="
      else if (ctx.NotEqual) operator = "!="
      return {
        kind: "binary_op",
        operator,
        left,
        right,
      }
    }
    return left
  }

  additiveExpression(ctx: any): ExpressionNode {
    let result = this.visit(ctx.multiplicativeExpression[0])
    for (let i = 1; i < ctx.multiplicativeExpression.length; i++) {
      const operator = ctx.Plus?.[i - 1] ? "+" : "-"
      const right = this.visit(ctx.multiplicativeExpression[i])
      result = {
        kind: "binary_op",
        operator: operator as "+" | "-",
        left: result,
        right,
      }
    }
    return result
  }

  multiplicativeExpression(ctx: any): ExpressionNode {
    let result = this.visit(ctx.pathExpression[0])
    for (let i = 1; i < ctx.pathExpression.length; i++) {
      const operator = ctx.Star?.[i - 1] ? "*" : "/"
      const right = this.visit(ctx.pathExpression[i])
      result = {
        kind: "binary_op",
        operator: operator as "*" | "/",
        left: result,
        right,
      }
    }
    return result
  }

  pathExpression(ctx: any): ExpressionNode {
    const primary = this.visit(ctx.primaryExpression)
    if (ctx.Its && ctx.Its.length > 0) {
      // Build path segments
      const segments: string[] = []
      if (primary.kind === "identifier") {
        segments.push(primary.name)
      } else {
        throw new Error("Path must start with an identifier")
      }
      for (const idCtx of ctx.identifier) {
        segments.push(this.visit(idCtx))
      }
      return {
        kind: "path",
        segments,
      }
    }
    return primary
  }

  primaryExpression(ctx: any): ExpressionNode {
    if (ctx.StringLiteral) {
      const value = ctx.StringLiteral[0].image.slice(1, -1) // Remove quotes
      return {
        kind: "literal",
        valueType: "string",
        value,
      }
    } else if (ctx.NumberLiteral) {
      const value = parseFloat(ctx.NumberLiteral[0].image)
      return {
        kind: "literal",
        valueType: "number",
        value,
      }
    } else if (ctx.Systemdate) {
      return {
        kind: "literal",
        valueType: "systemdate",
        value: "systemdate",
      }
    } else if (ctx.True) {
      return {
        kind: "literal",
        valueType: "boolean",
        value: true,
      }
    } else if (ctx.False) {
      return {
        kind: "literal",
        valueType: "boolean",
        value: false,
      }
    } else if (ctx.Nil) {
      return {
        kind: "literal",
        valueType: "nil",
        value: null,
      }
    } else if (ctx.identifier) {
      const name = this.visit(ctx.identifier)
      return {
        kind: "identifier",
        name,
      }
    } else if (ctx.expression) {
      return this.visit(ctx.expression)
    }
    throw new Error("Unknown primary expression")
  }

  simpleIdentifier(ctx: any): string {
    // Join all identifier tokens with spaces
    if (!ctx.Identifier || ctx.Identifier.length === 0) {
      throw new Error("No identifier found")
    }
    return ctx.Identifier.map((token: any) => token.image).join(" ")
  }

  typeName(ctx: any): string {
    // Type name is always a simple identifier (no underscores)
    return this.visit(ctx.simpleIdentifier)
  }

  simpleAttributeName(ctx: any): string {
    // Attribute name is always a simple identifier (no underscores)
    return this.visit(ctx.simpleIdentifier)
  }

  attributeName(ctx: any): string {
    // Attribute name with optional role prefix
    return this.visit(ctx.identifier)
  }

  identifier(ctx: any): string {
    // Build identifier, possibly with role prefix
    // identifier = simpleIdentifier ("_" simpleIdentifier)?

    if (!ctx.simpleIdentifier || ctx.simpleIdentifier.length === 0) {
      throw new Error("No identifier found")
    }

    const firstPart = this.visit(ctx.simpleIdentifier[0])

    if (!ctx.Underscore) {
      // No underscore, just return the simple identifier
      return firstPart
    }

    // Has underscore, get the second part
    if (ctx.simpleIdentifier.length < 2) {
      throw new Error("Expected second identifier after underscore")
    }

    const secondPart = this.visit(ctx.simpleIdentifier[1])
    return `${firstPart}_${secondPart}`
  }
}
