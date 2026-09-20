import { Schema, SchemaAST } from "effect"
import { FormReadOnly } from "./form-annotations"
import { FLATTEN_SYMBOL, STRUCTURAL_ONLY_SYMBOL } from "./form-schema"

/** Look through field wrappers on the encoded side, never into container children. */
export const fieldAnnotation = (ast: SchemaAST.AST, key: symbol): unknown => {
  const direct = ast.annotations[key]
  if (direct !== undefined) return direct
  if (ast._tag === "Transformation" || ast._tag === "Refinement")
    return fieldAnnotation(ast.from, key)
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
): SchemaAST.AST =>
  Schema.isPropertySignature(field)
    ? field.ast._tag === "PropertySignatureDeclaration"
      ? SchemaAST.annotations(field.ast.type, field.ast.annotations)
      : SchemaAST.annotations(field.ast.from.type, {
          ...field.ast.from.annotations,
          ...field.ast.to.annotations,
        })
    : field.ast

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
