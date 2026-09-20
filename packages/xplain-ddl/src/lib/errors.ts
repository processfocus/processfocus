import { Data } from "effect"

/**
 * Error that occurs during lexical analysis (tokenization)
 */
export class LexerError extends Data.TaggedError("LexerError")<{
  readonly message: string
  readonly line: number
  readonly column: number
}> {}

/**
 * Error that occurs during parsing (CST construction)
 */
export class ParserError extends Data.TaggedError("ParserError")<{
  readonly message: string
  readonly line: number
  readonly column: number
  readonly context?: string
}> {}

/**
 * Error that occurs during AST construction from CST
 */
export class ASTConstructionError extends Data.TaggedError(
  "ASTConstructionError",
)<{
  readonly message: string
}> {}

/**
 * Error that occurs during semantic validation
 */
export class SemanticError extends Data.TaggedError("SemanticError")<{
  readonly message: string
  readonly line: number
  readonly column: number
  readonly context?: string
}> {}

/**
 * Union of all possible parse errors
 */
export type ParseError =
  | LexerError
  | ParserError
  | ASTConstructionError
  | SemanticError
