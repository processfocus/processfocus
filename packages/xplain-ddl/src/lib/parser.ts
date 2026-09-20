import { CstParser } from "chevrotain"
import * as tok from "./lexer.js"

class XplainParser extends CstParser {
  constructor() {
    super(tok.allTokens, {
      recoveryEnabled: true,
      nodeLocationTracking: "full",
    })
    this.performSelfAnalysis()
  }

  // Entry point: parse a complete program
  program = this.RULE("program", () => {
    this.MANY(() => {
      this.SUBRULE(this.statement)
    })
  })

  // Statement dispatcher
  statement = this.RULE("statement", () => {
    this.OR([
      { ALT: () => this.SUBRULE(this.baseDeclaration) },
      { ALT: () => this.SUBRULE(this.typeDeclaration) },
      { ALT: () => this.SUBRULE(this.indexDeclaration) },
      { ALT: () => this.SUBRULE(this.defaultDeclaration) },
      { ALT: () => this.SUBRULE(this.initDeclaration) },
      { ALT: () => this.SUBRULE(this.extendDeclaration) },
      { ALT: () => this.SUBRULE(this.assertDeclaration) },
    ])
  })

  // base name (DataType).
  baseDeclaration = this.RULE("baseDeclaration", () => {
    this.CONSUME(tok.Base)
    this.SUBRULE(this.simpleIdentifier)
    this.CONSUME(tok.LParen)
    this.SUBRULE(this.dataType)
    this.CONSUME(tok.RParen)
    this.CONSUME(tok.Period)
  })

  // Data type: A10, B, C256, D, I5, J, R10,2, T, U
  dataType = this.RULE("dataType", () => {
    this.OR([
      {
        ALT: () => {
          this.CONSUME(tok.DataTypeA)
          this.CONSUME(tok.NumberLiteral, {
            ERR_MSG:
              "Text type (A) requires the maximum length. Expected format: A<max_length>, e.g., A255",
          })
        },
      },
      { ALT: () => this.CONSUME(tok.DataTypeB) },
      {
        ALT: () => {
          this.CONSUME(tok.DataTypeC)
          this.CONSUME5(tok.NumberLiteral, {
            ERR_MSG:
              "Case-insensitive text type (C) requires the maximum length. Expected format: C<max_length>, e.g., C255",
          })
        },
      },
      { ALT: () => this.CONSUME(tok.DataTypeD) },
      {
        ALT: () => {
          this.CONSUME(tok.DataTypeI)
          this.CONSUME2(tok.NumberLiteral, {
            ERR_MSG:
              "Integer type (I) requires the maximum number of digits. Expected format: I<digits>, e.g., I10",
          })
        },
      },
      { ALT: () => this.CONSUME(tok.DataTypeJ) },
      {
        ALT: () => {
          this.CONSUME(tok.DataTypeR)
          this.CONSUME3(tok.NumberLiteral, {
            ERR_MSG:
              "Real type (R) requires digits before and after decimal point. Expected format: R<digits_before>,<digits_after>, e.g., R10,2",
          })
          this.CONSUME(tok.Comma)
          this.CONSUME4(tok.NumberLiteral, {
            ERR_MSG:
              "Real type (R) requires digits after the comma. Expected format: R<digits_before>,<digits_after>, e.g., R10,2",
          })
        },
      },
      { ALT: () => this.CONSUME(tok.DataTypeT) },
      { ALT: () => this.CONSUME(tok.DataTypeU) },
    ])
  })

  // type name "prefix"? = attribute_list.
  typeDeclaration = this.RULE("typeDeclaration", () => {
    this.CONSUME(tok.Type)
    this.SUBRULE(this.simpleIdentifier)
    this.OPTION(() => {
      this.CONSUME(tok.StringLiteral)
    })
    this.CONSUME(tok.Equals)
    this.SUBRULE(this.attributeList)
    this.CONSUME(tok.Period)
  })

  // attribute_ref, attribute_ref, ...
  attributeList = this.RULE("attributeList", () => {
    this.SUBRULE(this.attributeRef)
    this.MANY(() => {
      this.CONSUME(tok.Comma)
      this.SUBRULE2(this.attributeRef)
    })
  })

  // Index attribute list: uses indexAttributeRef to reject path expressions
  indexAttributeList = this.RULE("indexAttributeList", () => {
    this.SUBRULE(this.indexAttributeRef)
    this.MANY(() => {
      this.CONSUME(tok.Comma)
      this.SUBRULE2(this.indexAttributeRef)
    })
  })

  // optional? identifier OR optional? [identifier]
  attributeRef = this.RULE("attributeRef", () => {
    this.OPTION(() => {
      this.CONSUME(tok.Optional)
    })
    this.OR([
      { ALT: () => this.SUBRULE(this.identifier) },
      {
        ALT: () => {
          this.CONSUME(tok.LBracket)
          this.SUBRULE2(this.identifier)
          this.CONSUME(tok.RBracket)
        },
      },
    ])
  })

  // Index attribute reference: optional? identifier only
  // No specialization brackets or path expressions allowed in indexes
  indexAttributeRef = this.RULE("indexAttributeRef", () => {
    this.OPTION(() => {
      this.CONSUME(tok.Optional)
    })
    this.SUBRULE(this.identifier)
    // Check if 'its' follows - this indicates an invalid path expression
    const la1 = this.LA(1)
    if (la1 && la1.tokenType === tok.Its) {
      // Consume the actual 'its' token with error message at its location
      this.CONSUME(tok.Its, {
        ERR_MSG:
          "Index attributes must be simple attribute names. Path expressions using 'its' are not allowed in index definitions.",
      })
    }
  })

  // unique? index type_name its index_name = attribute_list.
  indexDeclaration = this.RULE("indexDeclaration", () => {
    this.OPTION(() => {
      this.CONSUME(tok.Unique)
    })
    this.CONSUME(tok.Index)
    this.SUBRULE(this.typeName)
    this.CONSUME(tok.Its)
    this.SUBRULE(this.identifier) // index name
    this.CONSUME(tok.Equals)
    this.SUBRULE(this.indexAttributeList)
    this.CONSUME(tok.Period, {
      ERR_MSG:
        "Index attributes must be simple attribute names. Path expressions using 'its' are not allowed in index definitions.",
    })
  })

  // default type_name its attribute_name = expression.
  defaultDeclaration = this.RULE("defaultDeclaration", () => {
    this.CONSUME(tok.Default)
    this.SUBRULE(this.typeName)
    this.CONSUME(tok.Its)
    this.SUBRULE(this.simpleAttributeName)
    this.CONSUME(tok.Equals)
    this.SUBRULE(this.expression)
    this.CONSUME(tok.Period)
  })

  // init type_name its attribute_name = expression.
  initDeclaration = this.RULE("initDeclaration", () => {
    this.CONSUME(tok.Init)
    this.SUBRULE(this.typeName)
    this.CONSUME(tok.Its)
    this.SUBRULE(this.simpleAttributeName)
    this.CONSUME(tok.Equals)
    this.SUBRULE(this.expression)
    this.CONSUME(tok.Period)
  })

  // assert type_name its attribute_name (cardinality) = expression.
  assertDeclaration = this.RULE("assertDeclaration", () => {
    this.CONSUME(tok.Assert)
    this.SUBRULE(this.typeName)
    this.CONSUME(tok.Its)
    this.SUBRULE(this.simpleAttributeName)
    this.CONSUME(tok.LParen)
    this.SUBRULE(this.assertRange)
    this.CONSUME(tok.RParen)
    this.CONSUME(tok.Equals)
    this.SUBRULE(this.expression)
    this.CONSUME(tok.Period)
  })

  // extend type_name with attribute_name = expression.
  extendDeclaration = this.RULE("extendDeclaration", () => {
    this.CONSUME(tok.Extend)
    this.SUBRULE(this.typeName)
    this.CONSUME(tok.With, {
      ERR_MSG:
        "Use 'with' instead of 'its' in extend declarations. Correct syntax: extend <type> with <attribute> = <expression>",
    })
    this.SUBRULE(this.simpleAttributeName)
    this.CONSUME(tok.Equals)
    this.SUBRULE(this.expression)
    this.CONSUME(tok.Period)
  })

  // number..number or number..*
  cardinality = this.RULE("cardinality", () => {
    this.CONSUME(tok.NumberLiteral)
    this.CONSUME(tok.DotDot)
    this.OR([
      { ALT: () => this.CONSUME2(tok.NumberLiteral) },
      { ALT: () => this.CONSUME(tok.Star) },
    ])
  })

  // Assert ranges: cardinality for virtual attributes, or true for static CHECK constraints
  assertRange = this.RULE("assertRange", () => {
    this.OR([
      { ALT: () => this.SUBRULE(this.cardinality) },
      { ALT: () => this.CONSUME(tok.True) },
    ])
  })

  // Expression with operator precedence
  expression = this.RULE("expression", () => {
    this.SUBRULE(this.retrievalExpression)
  })

  // Retrieval function expression: setExpressionPerProperty | conditionalExpression
  retrievalExpression = this.RULE("retrievalExpression", () => {
    this.OR([
      {
        GATE: () => {
          // Check if first token is a retrieval function keyword
          const la1 = this.LA(1)
          if (!la1) return false
          return [
            tok.Count,
            tok.Max,
            tok.Min,
            tok.Total,
            tok.Nil,
            tok.Any,
            tok.Some,
          ].some((t) => la1.tokenType === t)
        },
        ALT: () => this.SUBRULE(this.setExpressionPerProperty),
      },
      { ALT: () => this.SUBRULE(this.conditionalExpression) },
    ])
  })

  // Set expression per property: setExpression per perPath
  setExpressionPerProperty = this.RULE("setExpressionPerProperty", () => {
    this.SUBRULE(this.setExpression)
    this.CONSUME(tok.Per)
    this.SUBRULE(this.perPath)
  })

  // Set expression: function type [its expression] [where predicate]
  setExpression = this.RULE("setExpression", () => {
    this.SUBRULE(this.retrievalFunction)
    this.SUBRULE(this.typeName)
    this.OPTION(() => {
      this.CONSUME(tok.Its)
      this.SUBRULE(this.conditionalExpression) // expression with calculations
    })
    this.OPTION2(() => {
      this.CONSUME(tok.Where)
      this.SUBRULE2(this.conditionalExpression) // where predicate
    })
  })

  // Retrieval function keywords
  retrievalFunction = this.RULE("retrievalFunction", () => {
    this.OR([
      { ALT: () => this.CONSUME(tok.Count) },
      { ALT: () => this.CONSUME(tok.Max) },
      { ALT: () => this.CONSUME(tok.Min) },
      { ALT: () => this.CONSUME(tok.Total) },
      { ALT: () => this.CONSUME(tok.Nil) },
      { ALT: () => this.CONSUME(tok.Any) },
      { ALT: () => this.CONSUME(tok.Some) },
    ])
  })

  // Per path: attributeName its attributeName its ... (chain of type references)
  // Examples: "parent", "b its a", "r_parent its child"
  // All attributes here should be types, a base is not valid.
  perPath = this.RULE("perPath", () => {
    this.SUBRULE(this.attributeName)
    this.MANY(() => {
      this.CONSUME(tok.Its)
      this.SUBRULE2(this.attributeName)
    })
  })

  // if condition then expr else expr
  conditionalExpression = this.RULE("conditionalExpression", () => {
    this.OR([
      {
        ALT: () => {
          this.CONSUME(tok.If)
          this.SUBRULE(this.logicalOrExpression)
          this.CONSUME(tok.Then)
          this.SUBRULE2(this.logicalOrExpression)
          this.CONSUME(tok.Else)
          this.SUBRULE3(this.logicalOrExpression)
        },
      },
      { ALT: () => this.SUBRULE4(this.logicalOrExpression) },
    ])
  })

  // Logical OR has lower precedence than comparisons.
  logicalOrExpression = this.RULE("logicalOrExpression", () => {
    this.SUBRULE(this.comparisonExpression)
    this.MANY(() => {
      this.CONSUME(tok.Or)
      this.SUBRULE2(this.comparisonExpression)
    })
  })

  // Comparison: >=, <=, >, <, ==, !=
  comparisonExpression = this.RULE("comparisonExpression", () => {
    this.SUBRULE(this.additiveExpression)
    this.OPTION(() => {
      this.OR([
        { ALT: () => this.CONSUME(tok.GreaterThanEqual) },
        { ALT: () => this.CONSUME(tok.LessThanEqual) },
        { ALT: () => this.CONSUME(tok.GreaterThan) },
        { ALT: () => this.CONSUME(tok.LessThan) },
        { ALT: () => this.CONSUME(tok.EqualEqual) },
        { ALT: () => this.CONSUME(tok.NotEqual) },
      ])
      this.SUBRULE2(this.additiveExpression)
    })
  })

  // Additive: +, -
  additiveExpression = this.RULE("additiveExpression", () => {
    this.SUBRULE(this.multiplicativeExpression)
    this.MANY(() => {
      this.OR([
        { ALT: () => this.CONSUME(tok.Plus) },
        { ALT: () => this.CONSUME(tok.Minus) },
      ])
      this.SUBRULE2(this.multiplicativeExpression)
    })
  })

  // Multiplicative: *, /
  multiplicativeExpression = this.RULE("multiplicativeExpression", () => {
    this.SUBRULE(this.pathExpression)
    this.MANY(() => {
      this.OR([
        { ALT: () => this.CONSUME(tok.Star) },
        { ALT: () => this.CONSUME(tok.Slash) },
      ])
      this.SUBRULE2(this.pathExpression)
    })
  })

  // Path: identifier its identifier its identifier...
  pathExpression = this.RULE("pathExpression", () => {
    this.SUBRULE(this.primaryExpression)
    this.MANY(() => {
      this.CONSUME(tok.Its)
      this.SUBRULE(this.identifier)
    })
  })

  // Primary: literal, identifier, (expression)
  primaryExpression = this.RULE("primaryExpression", () => {
    this.OR([
      { ALT: () => this.CONSUME(tok.StringLiteral) },
      { ALT: () => this.CONSUME(tok.NumberLiteral) },
      { ALT: () => this.CONSUME(tok.Systemdate) },
      { ALT: () => this.CONSUME(tok.True) },
      { ALT: () => this.CONSUME(tok.False) },
      { ALT: () => this.CONSUME(tok.Nil) },
      { ALT: () => this.SUBRULE(this.identifier) },
      {
        ALT: () => {
          this.CONSUME(tok.LParen)
          this.SUBRULE(this.expression)
          this.CONSUME(tok.RParen)
        },
      },
    ])
  })

  // Simple identifier: one or more identifier tokens (for base/type names)
  // Examples: "name", "invoice line"
  // This allows us to have spaces in identifiers.
  simpleIdentifier = this.RULE("simpleIdentifier", () => {
    this.AT_LEAST_ONE(() => {
      this.CONSUME(tok.Identifier)
    })
  })

  // Type name: always a simple identifier (no roles)
  // Examples: "invoice", "invoice line"
  typeName = this.RULE("typeName", () => {
    this.SUBRULE(this.simpleIdentifier)
  })

  // Attribute name without roles (prefixes).
  // Examples: "name", "unitprice", "amount"
  simpleAttributeName = this.RULE("simpleAttributeName", () => {
    this.SUBRULE(this.simpleIdentifier)
  })

  // Attribute name with optional role.
  // Examples: "name", "unit_price", "my amount"
  attributeName = this.RULE("attributeName", () => {
    this.SUBRULE(this.identifier)
  })

  // Identifier: simple or multi-word, optionally with role prefix
  // Examples: "name", "invoice line", "parent_invoice line"
  // Can also include keywords when used as names
  identifier = this.RULE("identifier", () => {
    this.SUBRULE(this.simpleIdentifier)
    this.OPTION(() => {
      this.CONSUME(tok.Underscore)
      this.SUBRULE2(this.simpleIdentifier)
    })
  })
}

// Create singleton parser instance
export const parser = new XplainParser()
