import type { Schema, SchemaAST } from "effect"
import { FormReadOnly } from "./form-annotations"
import { FLATTEN_SYMBOL, STRUCTURAL_ONLY_SYMBOL } from "./form-schema"

/** Look through field wrappers on the encoded side, never into container children. */
export const fieldAnnotation = (
  ast: SchemaAST.AST,
  key: symbol | string,
): unknown => {
  const direct =
    Reflect.get(ast.context?.annotations ?? {}, key) ??
    ast.checks
      ?.toReversed()
      .map((check) => Reflect.get(check.annotations ?? {}, key))
      .find((value) => value !== undefined) ??
    Reflect.get(ast.annotations ?? {}, key)
  if (direct !== undefined) return direct
  if (ast.encoding) {
    for (const link of ast.encoding) {
      const value = fieldAnnotation(link.to, key)
      if (value !== undefined) return value
    }
  }
  if (ast._tag === "Union") {
    for (const type of ast.types) {
      const value = fieldAnnotation(type, key)
      if (value !== undefined) return value
    }
  }
  return undefined
}

/** Property annotations override the underlying encoded field's annotations. */
export const fieldInputAst = (
  field: Schema.Struct.Fields[string],
): SchemaAST.AST => field.ast

export const hasStructuralOnlyAnnotation = (
  field: Schema.Struct.Fields[string],
): boolean =>
  fieldAnnotation(fieldInputAst(field), STRUCTURAL_ONLY_SYMBOL) !== undefined

export const hasFlattenAnnotation = (
  field: Schema.Struct.Fields[string],
): boolean =>
  fieldAnnotation(fieldInputAst(field), FLATTEN_SYMBOL) !== undefined

export const isReadOnlyField = (field: Schema.Struct.Fields[string]): boolean =>
  fieldAnnotation(fieldInputAst(field), FormReadOnly) === true
