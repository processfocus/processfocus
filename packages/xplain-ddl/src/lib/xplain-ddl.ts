import type { CstNode, IToken } from "chevrotain"
import { Effect } from "effect"
import type { Program } from "./ast.js"
import {
  ASTConstructionError,
  LexerError,
  type ParseError,
  ParserError,
} from "./errors.js"
import { XplainLexer } from "./lexer.js"
import { parser } from "./parser.js"
import { resolveBaseNames } from "./transformer.js"
import { validateSemantics } from "./validator.js"
import { XplainVisitor } from "./visitor.js"

const visitor = new XplainVisitor()

/**
 * Tokenize the source code
 */
const tokenize = (source: string) =>
  Effect.gen(function* () {
    const lexResult = XplainLexer.tokenize(source)

    if (lexResult.errors.length > 0) {
      const errors = lexResult.errors.map(
        (error) =>
          new LexerError({
            message: error.message,
            line: error.line ?? 0,
            column: error.column ?? 0,
          }),
      )
      return yield* Effect.fail(errors)
    }

    return lexResult.tokens
  })

/**
 * Parse tokens into CST
 */
const parseTokens = (tokens: IToken[]) =>
  Effect.gen(function* () {
    parser.input = tokens
    const cst = parser.program()

    if (parser.errors.length > 0) {
      const errors = parser.errors.map((error) => {
        const baseError = {
          message: error.message,
          line: error.token.startLine ?? 0,
          column: error.token.startColumn ?? 0,
        }
        return new ParserError(
          error.context
            ? { ...baseError, context: JSON.stringify(error.context) }
            : baseError,
        )
      })
      return yield* Effect.fail(errors)
    }

    return cst
  })

/**
 * Build AST from CST
 */
const buildAST = (cst: CstNode) =>
  Effect.try({
    try: () => visitor.visit(cst),
    catch: (error) =>
      new ASTConstructionError({
        message: error instanceof Error ? error.message : String(error),
      }),
  })

/**
 * Parse Xplain DDL source code into an AST
 *
 * Pipeline:
 * 1. Tokenize - Convert source to tokens
 * 2. Parse - Build CST from tokens
 * 3. Build AST - Transform CST to AST
 * 4. Resolve base names - Pure transformation to resolve attribute base names
 * 5. Validate - Pure validation (no mutations)
 */
export const parse = (source: string): Effect.Effect<Program, ParseError[]> =>
  Effect.gen(function* () {
    // Tokenize
    const tokens = yield* tokenize(source)

    // Parse to CST
    const cst = yield* parseTokens(tokens)

    // Build AST
    const rawAst = yield* buildAST(cst).pipe(
      Effect.mapError((error) => [error]),
    )

    // Resolve base names (pure transformation)
    const ast = yield* resolveBaseNames(rawAst)

    // Validate semantics (pure validation, no mutations)
    yield* validateSemantics(ast)

    return ast
  })
