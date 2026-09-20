// AST node types for Xplain DDL

// Top-level program
export interface Program {
  bases: BaseDeclaration[]
  types: TypeDeclaration[]
  _orphanedExtends?: Array<{ typeName: string; extend: ExtendNode }>
  _orphanedIndexes?: Array<{ typeName: string; index: IndexNode }>
  _orphanedAsserts?: Array<{ typeName: string; assert: AssertConstraintNode }>
}

// Base declaration
export interface BaseDeclaration {
  kind: "base"
  name: string
  dataType: DataType
  line?: number
  column?: number
}

export type DataType =
  | { type: "text"; maxLength: number } // A10
  | { type: "boolean" } // B
  | { type: "citext"; maxLength: number } // C10
  | { type: "datetime" } // D
  | { type: "integer"; maxDigits: number } // I5
  | { type: "json" } // J
  | { type: "real"; digitsBefore: number; digitsAfter: number } // R10,2
  | { type: "unlimited_text" } // T
  | { type: "urn" } // U

// Type declaration
export interface TypeDeclaration {
  kind: "type"
  name: string
  idPrefix?: string
  attributes: AttributeNode[]
  extends: ExtendNode[]
  asserts: AssertConstraintNode[]
  indexes: IndexNode[]
  uniqueIndexes: IndexNode[]
  line?: number
  column?: number
}

// Attribute reference in type
export interface AttributeNode {
  name: string // e.g. "unit_price"
  baseName: string // e.g. "price" (resolved from name)
  optional: boolean
  isSpecialization: boolean // true if attribute is a specialization ([type])
  default?: ExpressionNode
  init?: ExpressionNode
  line?: number
  column?: number
}

// Index definition
export interface IndexNode {
  name: string
  attributes: string[] // list of attribute names
  unique: boolean
  line?: number
  column?: number
}

// Extend (virtual attribute)
export interface ExtendNode {
  attributeName: string
  expression: ExpressionNode
  cardinality?: Cardinality // Optional cardinality for asserts
  line?: number
  column?: number
}

export interface AssertConstraintNode {
  name: string
  expression: ExpressionNode
  line?: number
  column?: number
}

// Assert (calculated/virtual column), only used during parsing, then converted to an ExtendNode
export interface VirtualAssertNode {
  kind: "assert"
  assertKind: "virtual"
  typeName: string
  attributeName: string
  cardinality: Cardinality
  expression: ExpressionNode
  line?: number
  column?: number
}

export interface StaticAssertNode {
  kind: "assert"
  assertKind: "constraint"
  typeName: string
  attributeName: string
  expression: ExpressionNode
  line?: number
  column?: number
}

export type AssertNode = VirtualAssertNode | StaticAssertNode

export interface BooleanAssertRange {
  kind: "boolean"
  value: true
}

export type AssertRange = Cardinality | BooleanAssertRange

export interface Cardinality {
  min: number
  max: number | "unbounded" // "*" becomes "unbounded"
}

// Expression nodes
export type ExpressionNode =
  | LiteralNode
  | IdentifierNode
  | BinaryOpNode
  | ConditionalNode
  | PathNode
  | RetrievalFunctionNode

export interface LiteralNode {
  kind: "literal"
  valueType: "string" | "number" | "systemdate" | "boolean" | "nil"
  value: string | number | "systemdate" | boolean | null
}

export interface IdentifierNode {
  kind: "identifier"
  name: string
}

export interface BinaryOpNode {
  kind: "binary_op"
  operator: "+" | "-" | "*" | "/" | ">=" | "<=" | ">" | "<" | "==" | "!=" | "or"
  left: ExpressionNode
  right: ExpressionNode
}

export interface ConditionalNode {
  kind: "conditional"
  condition: ExpressionNode
  thenExpr: ExpressionNode
  elseExpr: ExpressionNode
}

export interface PathNode {
  kind: "path"
  segments: string[] // ["product", "price"] for "product its price"
}

export interface RetrievalFunctionNode {
  kind: "retrieval_function"
  function: "count" | "max" | "min" | "total" | "nil" | "any" | "some"
  typeName: string // The type being aggregated (e.g., "invoice line")
  expression?: ExpressionNode // Optional its expression with calculations on final property
  wherePredicate?: ExpressionNode // Optional where clause for filtering
  perPath: PathNode // The grouping path (always an "its" chain)
}
