import { Lexer, createToken } from "chevrotain"

// Keywords (must come before Identifier)
export const Base = createToken({ name: "Base", pattern: /base\b/ })
export const Type = createToken({ name: "Type", pattern: /type\b/ })
export const Index = createToken({ name: "Index", pattern: /index\b/ })
export const Unique = createToken({ name: "Unique", pattern: /unique\b/ })
export const Default = createToken({ name: "Default", pattern: /default\b/ })
export const Init = createToken({ name: "Init", pattern: /init\b/ })
export const Assert = createToken({ name: "Assert", pattern: /assert\b/ })
export const Extend = createToken({ name: "Extend", pattern: /extend\b/ })
export const Optional = createToken({ name: "Optional", pattern: /optional\b/ })
export const If = createToken({ name: "If", pattern: /if\b/ })
export const Then = createToken({ name: "Then", pattern: /then\b/ })
export const Else = createToken({ name: "Else", pattern: /else\b/ })
export const Or = createToken({ name: "Or", pattern: /or\b/ })
export const Its = createToken({ name: "Its", pattern: /its\b/ })
export const With = createToken({ name: "With", pattern: /with\b/ })
export const Per = createToken({ name: "Per", pattern: /per\b/ })
export const Where = createToken({ name: "Where", pattern: /where\b/ })

// Special literals
export const Systemdate = createToken({
  name: "Systemdate",
  pattern: /systemdate\b/,
})

// Boolean literals
export const True = createToken({ name: "True", pattern: /true\b/ })
export const False = createToken({ name: "False", pattern: /false\b/ })

// Retrieval functions
export const Count = createToken({ name: "Count", pattern: /count\b/ })
export const Max = createToken({ name: "Max", pattern: /max\b/ })
export const Min = createToken({ name: "Min", pattern: /min\b/ })
export const Total = createToken({ name: "Total", pattern: /total\b/ })
export const Nil = createToken({ name: "Nil", pattern: /nil\b/ })
export const Any = createToken({ name: "Any", pattern: /any\b/ })
export const Some = createToken({ name: "Some", pattern: /some\b/ })

// Operators (longer patterns first to avoid ambiguity)
export const GreaterThanEqual = createToken({
  name: "GreaterThanEqual",
  pattern: />=/,
})
export const LessThanEqual = createToken({
  name: "LessThanEqual",
  pattern: /<=/,
})
export const EqualEqual = createToken({ name: "EqualEqual", pattern: /==/ })
export const NotEqual = createToken({ name: "NotEqual", pattern: /!=/ })
export const GreaterThan = createToken({ name: "GreaterThan", pattern: />/ })
export const LessThan = createToken({ name: "LessThan", pattern: /</ })
export const Plus = createToken({ name: "Plus", pattern: /\+/ })
export const Minus = createToken({ name: "Minus", pattern: /-/ })
export const Star = createToken({ name: "Star", pattern: /\*/ })
export const Slash = createToken({ name: "Slash", pattern: /\// })
export const Equals = createToken({ name: "Equals", pattern: /=/ })

// Delimiters
export const LParen = createToken({ name: "LParen", pattern: /\(/ })
export const RParen = createToken({ name: "RParen", pattern: /\)/ })
export const Comma = createToken({ name: "Comma", pattern: /,/ })
export const Period = createToken({ name: "Period", pattern: /\./ })
export const DotDot = createToken({ name: "DotDot", pattern: /\.\./ })

// Brackets (for specialization)
export const LBracket = createToken({ name: "LBracket", pattern: /\[/ })
export const RBracket = createToken({ name: "RBracket", pattern: /\]/ })

// Literals
export const StringLiteral = createToken({
  name: "StringLiteral",
  pattern: /"(?:[^"\\]|\\.)*"/,
})
export const NumberLiteral = createToken({
  name: "NumberLiteral",
  pattern: /-?\d+(?:\.\d+)?/,
})

// Data type tokens (for base declarations)
export const DataTypeA = createToken({ name: "DataTypeA", pattern: /A/ })
export const DataTypeB = createToken({ name: "DataTypeB", pattern: /B/ })
export const DataTypeC = createToken({ name: "DataTypeC", pattern: /C/ })
export const DataTypeD = createToken({ name: "DataTypeD", pattern: /D/ })
export const DataTypeI = createToken({ name: "DataTypeI", pattern: /I/ })
export const DataTypeJ = createToken({ name: "DataTypeJ", pattern: /J/ })
export const DataTypeR = createToken({ name: "DataTypeR", pattern: /R/ })
export const DataTypeT = createToken({ name: "DataTypeT", pattern: /T/ })
export const DataTypeU = createToken({ name: "DataTypeU", pattern: /U/ })

// Underscore (used to separate role from type name in attributes)
export const Underscore = createToken({ name: "Underscore", pattern: /_/ })

// Simple identifier - matches single lowercase word
export const Identifier = createToken({
  name: "Identifier",
  pattern: /[a-z][a-z0-9]*/,
})

// Comment (skipped)
const Comment = createToken({
  name: "Comment",
  pattern: /#[^\n]*/,
  group: Lexer.SKIPPED,
})

// Whitespace (skipped)
const WhiteSpace = createToken({
  name: "WhiteSpace",
  pattern: /\s+/,
  group: Lexer.SKIPPED,
})

// All tokens in order of precedence
export const allTokens = [
  // Whitespace and comments first (skipped)
  WhiteSpace,
  Comment,
  // Keywords before identifiers
  Base,
  Type,
  Index,
  Unique,
  Default,
  Init,
  Assert,
  Extend,
  Optional,
  If,
  Then,
  Else,
  Or,
  Its,
  With,
  Per,
  Where,
  // Special literals
  Systemdate,
  // Boolean literals
  True,
  False,
  // Retrieval functions
  Count,
  Max,
  Min,
  Total,
  Nil,
  Any,
  Some,
  // Data type letters
  DataTypeA,
  DataTypeB,
  DataTypeC,
  DataTypeD,
  DataTypeI,
  DataTypeJ,
  DataTypeR,
  DataTypeT,
  DataTypeU,
  // Operators (longer patterns first)
  DotDot,
  GreaterThanEqual,
  LessThanEqual,
  EqualEqual,
  NotEqual,
  GreaterThan,
  LessThan,
  Plus,
  Minus,
  Star,
  Slash,
  Equals,
  // Delimiters
  LParen,
  RParen,
  LBracket,
  RBracket,
  Comma,
  Period,
  Underscore,
  // Literals
  StringLiteral,
  NumberLiteral,
  // Identifiers
  Identifier,
]

// Create lexer instance
export const XplainLexer = new Lexer(allTokens)
