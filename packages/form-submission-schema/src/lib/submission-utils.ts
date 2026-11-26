import { Option, Schema, type SchemaAST, SchemaIssue } from "effect"
import { fieldAnnotation } from "@pf/form-schema"
import { submissionSchemaSync } from "./form-submission-schema"

interface ValidationError {
  readonly field: string
  readonly message: string
}
const isKeyObject = (segment: unknown): segment is { key: PropertyKey } =>
  typeof segment === "object" &&
  segment !== null &&
  "key" in segment &&
  typeof segment.key !== "undefined"

/**
 * Extracts validation errors from an Effect Schema ParseError.
 * Field path is returned in dot notation (e.g., "address.city").
 */
export const extractValidationErrors = (
  parseError: Schema.SchemaError,
): ValidationError[] => {
  const formatted = SchemaIssue.makeFormatterStandardSchemaV1()(
    parseError.issue,
  ).issues

  return formatted.map((issue) => ({
    field: (issue.path ?? [])
      .map((segment) =>
        isKeyObject(segment) ? String(segment.key) : String(segment),
      )
      .join("."),
    message: issue.message,
  }))
}

export const getSubmissionFields = (fields: Schema.Struct.Fields) =>
  submissionSchemaSync(Schema.Struct(fields)).fields

export const getSchemaAnnotationDeep = (
  schema: Schema.Struct.Fields[string],
  annotationId: symbol,
): Option.Option<unknown> => {
  const seen = new Set<SchemaAST.AST>()
  const visit = (ast: SchemaAST.AST): Option.Option<unknown> => {
    if (seen.has(ast)) return Option.none()
    seen.add(ast)
    const direct = fieldAnnotation(ast, annotationId)
    if (direct !== undefined) return Option.some(direct)
    const children: SchemaAST.AST[] = ast.encoding?.map((link) => link.to) ?? []
    switch (ast._tag) {
      case "Objects":
        children.push(
          ...ast.propertySignatures.map((property) => property.type),
        )
        for (const signature of ast.indexSignatures)
          children.push(signature.parameter, signature.type)
        break
      case "Arrays":
        children.push(...ast.elements, ...ast.rest)
        break
      case "Union":
        children.push(...ast.types)
        break
      case "Suspend":
        children.push(ast.thunk())
        break
    }
    for (const child of children) {
      const result = visit(child)
      if (Option.isSome(result)) return result
    }
    return Option.none()
  }
  return visit(schema.ast)
}
